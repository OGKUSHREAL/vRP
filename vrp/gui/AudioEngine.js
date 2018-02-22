
var is_playing = function(media)
{
  return media.currentTime > 0 && !media.paused && !media.ended && media.readyState > 2;
}

function AudioEngine()
{
  this.c = new AudioContext();
  this.sources = {};
  this.listener = this.c.listener;
  this.listener.upX.value = 0;
  this.listener.upY.value = 0;
  this.listener.upZ.value = 1;

  this.last_check = new Date().getTime();

  //VoIP
  this.voice_channels = {}; 

  var _this = this;

  //encoder
  this.mic_enc = new libopus.Encoder(1,48000,24000,true);

  //processor
  this.mic_processor = this.c.createScriptProcessor(4096,1,1);
  this.mic_processor.onaudioprocess = function(e){
    var samples = e.inputBuffer.getChannelData(0);

    //convert to Int16 pcm
    var isamples = new Int16Array(samples.length);
    for(var i = 0; i < samples.length; i++){
      var s = samples[i];
      s *= 32768 ;
      if(s > 32767) 
        s = 32767;
      else if(s < -32768) 
        s = -32768;

      isamples[i] = s;
    }

    //encode
    _this.mic_enc.input(samples);
    var data;
    while(data = _this.mic_enc.output()){
      var buffer = data.slice().buffer;

      //send packet to active/connected peers
      for(var nchannel in _this.voice_channels){
        var channel = _this.voice_channels[nchannel];
        for(var player in channel){
          if(player != "_config"){
            var peer = channel[player];
            if(peer.connected && peer.active)
              peer.data_channel.send(buffer);
          }
        }
      }
    }
  }

  this.mic_processor.connect(this.c.destination);

  //mic stream
  navigator.mediaDevices.getUserMedia({
    audio: {
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
      latency: 0
    }
  }).then(function(stream){ 
    _this.mic_node = _this.c.createMediaStreamSource(stream);
    _this.mic_node.connect(_this.c.destination);
    _this.mic_node.connect(_this.mic_processor);
  });


}

AudioEngine.prototype.setListenerData = function(data)
{
  var l = this.listener;
  l.positionX.value = data.x;
  l.positionY.value = data.y;
  l.positionZ.value = data.z;
  l.forwardX.value = data.fx;
  l.forwardY.value = data.fy;
  l.forwardZ.value = data.fz;

  var time = new Date().getTime();
  if(time-this.last_check >= 2000){ // every 2s
    this.last_check = time;

    // pause too far away sources and unpause nearest sources paused
    for(var name in this.sources){
      var source = this.sources[name];

      if(source[3]){ //spatialized
        var dx = data.x-source[2].positionX.value;
        var dy = data.y-source[2].positionY.value;
        var dz = data.z-source[2].positionZ.value;
        var dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
        var active_dist = source[2].maxDistance*2;

        if(!is_playing(source[0]) && dist <= active_dist)
          source[0].play();
        else if(is_playing(source[0]) && dist > active_dist)
          source[0].pause();
      }
    }
  }
}

// return [audio, node, panner]
AudioEngine.prototype.setupAudioSource = function(data)
{
  var audio = new Audio();
  audio.src = data.url;
  audio.volume = data.volume;

  var spatialized = (data.x != null && data.y != null && data.z != null && data.max_dist != null);
  var node = null;
  var panner = null;

  if(spatialized){
    node = this.c.createMediaElementSource(audio);

    panner = this.c.createPanner();
//    panner.panningModel = "HRTF";
    panner.distanceModel = "inverse";
    panner.refDistance = 1;
    panner.maxDistance = data.max_dist;
    panner.rolloffFactor = 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 0;
    panner.coneOuterGain = 0;
    panner.positionX.value = data.x;
    panner.positionY.value = data.y;
    panner.positionZ.value = data.z;

    node.connect(panner);
    panner.connect(this.c.destination);
  }

  return [audio, node, panner, spatialized];
}

AudioEngine.prototype.playAudioSource = function(data)
{
  var _this = this;

  var spatialized = (data.x != null && data.y != null && data.z != null && data.max_dist != null);
  var dist = 10;
  var active_dist = 0;

  if(spatialized){
    var dx = this.listener.positionX.value-data.x;
    var dy = this.listener.positionY.value-data.y;
    var dz = this.listener.positionZ.value-data.z;
    dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
    active_dist = data.max_dist*2;
  }

  if(!spatialized || dist <= active_dist){
    var source = this.setupAudioSource(data);

    // bind deleter
    if(spatialized){
      source[0].onended = function(){
        source[2].disconnect(_this.c.destination);
      }
    }

    // play
    source[0].play();
  }
}

AudioEngine.prototype.setAudioSource = function(data)
{
  this.removeAudioSource(data);

  var source = this.setupAudioSource(data);
  source[0].loop = true;
  this.sources[data.name] = source;

  // play
  var dist = 10;
  var active_dist = 0;
  if(source[3]){ // spatialized
    var dx = this.listener.positionX.value-source[2].positionX.value;
    var dy = this.listener.positionY.value-source[2].positionY.value;
    var dz = this.listener.positionZ.value-source[2].positionZ.value;
    dist = Math.sqrt(dx*dx+dy*dy+dz*dz);
    active_dist = source[2].maxDistance*2;
  }

  if(!source[3] || dist <= active_dist)
    source[0].play();
}

AudioEngine.prototype.removeAudioSource = function(data)
{
  var source = this.sources[data.name];
  if(source){
    delete this.sources[data.name];
    if(is_playing(source[0]))
      source[0].pause();
    if(source[3]) //spatialized
      source[2].disconnect(this.c.destination);
  }
}

//VoIP

AudioEngine.prototype.setPeerConfiguration = function(data)
{
  this.peer_config = data.config;
}

AudioEngine.prototype.setupPeer = function(peer)
{
  var _this = this;

  //decoder
  peer.dec = new libopus.Decoder(1,48000);
  peer.psamples = []; //packets samples
  peer.processor = this.c.createScriptProcessor(4096,0,1);
  peer.processor.onaudioprocess = function(e){
    var out = e.outputBuffer.getChannelData(0);

    //feed samples to output
    var nsamples = 0;
    var i = 0;
    while(nsamples < out.length && i < peer.psamples.length){
      var p = peer.psamples[i];
      var take = Math.min(p.length, out.length-nsamples);

      //write packet samples to output
      for(var k = 0; k < take; k++){
        //convert from int16 to float
        var s = p[k];
        s /= 32768 ;
        if(s > 1) 
          s = 1;
        else if(s < -1) 
          s = -1;

        out[nsamples+k] = s;
      }

      //advance
      nsamples += take;

      if(take < p.length){ //partial samples
        //add rest packet
        peer.psamples.splice(i+1,0,p.subarray(take));
      }

      i++;
    }

    //remove processed packets
    peer.psamples.splice(0,i);
  }
  peer.processor.connect(this.c.destination);

  //setup data channel (UDP-like)
  peer.data_channel = peer.conn.createDataChannel(peer.channel, {
    ordered: false,
    negotiated: true,
    maxRetransmits: 0,
    id: 0
  });
  peer.data_channel.binaryType = "arraybuffer";

  peer.data_channel.onopen = function(){
    $.post("http://vrp/audio",JSON.stringify({act: "voice_connected", player: peer.player, channel: peer.channel, origin: peer.origin})); 
    peer.connected = true;
  }

  peer.data_channel.onclose = function(){
    $.post("http://vrp/audio",JSON.stringify({act: "voice_disconnected", player: peer.player, channel: peer.channel})); 
    _this.disconnectVoice({channel: peer.channel, player: peer.player});
  }

  peer.data_channel.onmessage = function(e){
    //receive opus packet
    peer.dec.input(new Uint8Array(e.data));
    var data;
    while(data = peer.dec.ouput())
      peer.psamples.push(data.slice());
  }

  //ice
  peer.conn.onicecandidate = function(e){
    $.post("http://vrp/audio",JSON.stringify({act: "voice_peer_signal", player: peer.player, data: {channel: peer.channel, candidate: e.candidate}})); 
  }
}

AudioEngine.prototype.getChannel = function(channel)
{
  var r = this.voice_channels[channel];
  if(!r){
    r = {};
    this.voice_channels[channel] = r;
  }

  return r;
}

AudioEngine.prototype.connectVoice = function(data)
{
  //close previous peer
  this.disconnectVoice(data);

  var channel = this.getChannel(data.channel);

  //setup new peer
  var peer = {
    conn: new RTCPeerConnection(this.peer_config),
    channel: data.channel,
    player: data.player,
    origin: true,
    candidate_queue: []
  }
  channel[data.player] = peer;

  //create data channel
  this.setupPeer(peer);

  //SDP
  peer.conn.createOffer().then(function(sdp){
    $.post("http://vrp/audio",JSON.stringify({act: "voice_peer_signal", player: data.player, data: {channel: data.channel, sdp_offer: sdp}})); 
    peer.conn.setLocalDescription(sdp);
  });
}

AudioEngine.prototype.disconnectVoice = function(data)
{
  var channel = this.getChannel(data.channel);
  //close peer
  var peer = channel[data.player];
  if(peer && peer.conn.connectionState != "closed")
    peer.conn.close();

  delete channel[data.player];
}

AudioEngine.prototype.voicePeerSignal = function(data)
{
  var channel = this.getChannel(data.data.channel);
  if(data.data.candidate){ //candidate
    var peer = channel[data.player];
    if(peer){
      if(peer.initialized) //valid remote description
        peer.conn.addIceCandidate(new RTCIceCandidate(data.data.candidate));
      else
        peer.candidate_queue.push(new RTCIceCandidate(data.data.candidate));
    }
  }
  else if(data.data.sdp_offer){ //offer
    //disconnect peer
    this.disconnectVoice({channel: data.data.channel, player: data.player});

    //setup answer peer
    var peer = {
      conn: new RTCPeerConnection(this.peer_config),
      channel: data.data.channel,
      player: data.player
    }

    channel[data.player] = peer;
    this.setupPeer(peer);

    //SDP
    peer.conn.setRemoteDescription(data.data.sdp_offer);
    peer.initialized = true;
    peer.conn.createAnswer().then(function(sdp){
      $.post("http://vrp/audio",JSON.stringify({act: "voice_peer_signal", player: data.player, data: {channel: data.data.channel, sdp_answer: sdp}})); 
      peer.conn.setLocalDescription(sdp);
    });
  }
  else if(data.data.sdp_answer){ //answer
    var peer = channel[data.player];
    if(peer){
      peer.conn.setRemoteDescription(data.data.sdp_answer);
      peer.initialized = true;
      //add candidates
      for(var i = 0; i < peer.candidate_queue.length; i++)
        peer.conn.addIceCandidate(peer.candidate_queue[i]);
      peer.candidate_queue = [];
    }
  }
}

AudioEngine.prototype.setVoiceState = function(data)
{
  var channel = this.getChannel(data.channel);
  if(data.player != null){ //specific player
    var peer = channel[data.player];
    if(peer)
      peer.active = data.active;
  }
  else{ //entire channel
    for(var player in channel){
      if(player != "_config")
        channel[player].active = data.active;
    }
  }
}

AudioEngine.prototype.configureVoice = function(data)
{
  var channel = this.getChannel(data.channel);
  channel._config = data.config;
}
