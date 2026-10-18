{ pkgs }:
let
  revision = "f3ff3571791e39611d31c381e3a41a3af07b4987";
  asset =
    name: hash:
    pkgs.fetchurl {
      url = "https://huggingface.co/hexgrad/Kokoro-82M/resolve/${revision}/${name}";
      inherit hash;
    };
  model = asset "kokoro-v1_0.pth" "sha256-SW26EY0aWPXz2y78iNvcIW4Eg/yJ/m5H7h8sU/GK0eQ=";
  config = asset "config.json" "sha256-WrsB4kA7ByvwPQT94WBEPiCdeg2tSaQjvhUZa5tDwX8=";
  heart = asset "voices/af_heart.pt" "sha256-CrVwm4/6sZv9hJzRHZj3W2CvdzMlOtDWexI4KhAstP8=";
  bella = asset "voices/af_bella.pt" "sha256-jLZOAvzI3gMnqOE4F+ScdslF7PAFLOrJfTCBSA6OSNY=";
  assets = pkgs.runCommand "liveview-kokoro-assets" { } ''
    mkdir -p $out/voices
    ln -s ${model} $out/kokoro-v1_0.pth
    ln -s ${config} $out/config.json
    ln -s ${heart} $out/voices/af_heart.pt
    ln -s ${bella} $out/voices/af_bella.pt
  '';
  python = pkgs.python3.withPackages (ps: [
    ps.kokoro
    ps.soundfile
    ps.spacy-models.en_core_web_sm
  ]);
in
pkgs.writeShellApplication {
  name = "liveview-kokoro-tts";
  runtimeInputs = [
    python
    pkgs.ffmpeg
  ];
  text = ''
    export LIVEVIEW_KOKORO_ASSETS=${assets}
    export HF_HUB_OFFLINE=1
    export TRANSFORMERS_OFFLINE=1
    exec python ${../tools/kokoro-tts.py} "$@"
  '';
}
