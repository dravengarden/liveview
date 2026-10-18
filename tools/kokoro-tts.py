#!/usr/bin/env python3
"""Offline, chapter-batched Kokoro adapter with source-unit timing.

Model assets and the English tokenizer are provided by the optional Nix package.
No downloads, network service, or credentials are needed at synthesis time.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile


def unit_marks(starts, duration_ms):
    """Retain every source index, including intentionally silent units."""
    # Silent units get zero duration at the next spoken boundary, rather than
    # stealing the preceding sentence's time range.
    next_start = duration_ms / 1000
    resolved = list(starts)
    for index in range(len(resolved) - 1, -1, -1):
        if resolved[index] is None:
            resolved[index] = next_start
        else:
            next_start = resolved[index]
    boundaries = []
    previous = 0
    for start in resolved:
        position = round(start * 1000)
        previous = max(previous, min(duration_ms, position))
        boundaries.append(previous)
    return [
        {"idx": i, "start_ms": start,
         "end_ms": boundaries[i + 1] if i + 1 < len(boundaries) else duration_ms}
        for i, start in enumerate(boundaries)
    ]


def synthesize(texts, voice, audio_path, marks_path):
    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KModel, KPipeline

    assets = Path(os.environ["LIVEVIEW_KOKORO_ASSETS"])
    voice_path = assets / "voices" / f"{voice}.pt"
    if voice not in {"af_heart", "af_bella"} or not voice_path.is_file():
        raise ValueError("Voice is not installed")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    model = KModel(repo_id="hexgrad/Kokoro-82M", config=str(assets / "config.json"),
                   model=str(assets / "kokoro-v1_0.pth")).eval()
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", model=model, device="cpu")
    tokens = []
    owners = {}
    audible_units = set()
    for index, text in enumerate(texts):
        if not text.strip():
            continue
        phonemes, unit_tokens = pipeline.g2p(text)
        if not any(char in model.vocab and not char.isspace() for char in phonemes):
            continue
        if not unit_tokens:
            raise ValueError(f"No pronunciation for nonempty unit {index}")
        # Keep adjacent short turns in one acoustic context. Token identity
        # survives Kokoro's bounded chunker and carries the original unit index.
        unit_tokens[-1].whitespace = " "
        for token in unit_tokens:
            owners[id(token)] = index
        tokens.extend(unit_tokens)
        audible_units.add(index)
    if not tokens:
        raise ValueError("No speakable text")
    starts = [None] * len(texts)
    pieces = []
    elapsed_samples = 0
    for result in pipeline.generate_from_tokens(tokens, voice=str(voice_path)):
        samples = result.audio.detach().cpu().numpy()
        # Map the exact phoneme stream accepted by KModel to source units.
        # Punctuation-only units and unsupported phonemes must not shift the
        # indices of the sentences that follow them.
        # pred_dur covers BOS + the vocabulary-filtered stream + EOS at 40 Hz.
        chars = []
        for token in result.tokens or []:
            index = owners[id(token)]
            chars.extend((char, index) for char in token.phonemes or "")
            if token.whitespace:
                chars.append((" ", index))
        while chars and chars[0][0].isspace():
            chars.pop(0)
        while chars and chars[-1][0].isspace():
            chars.pop()
        if "".join(char for char, _ in chars) != result.phonemes:
            raise ValueError("Tokenizer truncated a source unit")
        encoded = [(char, index) for char, index in chars if char in model.vocab]
        durations = result.pred_dur.tolist()
        if len(durations) != len(encoded) + 2:
            raise ValueError("Phoneme duration count does not match input")
        frames = max(0, durations[0] - 3)
        for (char, index), duration in zip(encoded, durations[1:-1]):
            if starts[index] is None and not char.isspace():
                starts[index] = elapsed_samples / 24000 + frames / 40
            frames += duration
        pieces.append(samples)
        elapsed_samples += len(samples)
    missing = [i for i in audible_units if starts[i] is None]
    if not pieces or missing:
        raise ValueError(f"Incomplete audio alignment for units {missing}")
    samples = np.concatenate(pieces)
    with tempfile.TemporaryDirectory(prefix="lv-kokoro-") as temp:
        wav = Path(temp) / "chapter.wav"
        sf.write(wav, samples, 24000, subtype="PCM_16")
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(wav),
                        "-c:a", "libmp3lame", "-b:a", "96k", "-ac", "1",
                        str(audio_path)], check=True, timeout=120)
    marks_path.write_text(json.dumps(unit_marks(starts, round(len(samples) / 24))),
                          encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--marks", type=Path, required=True)
    args = parser.parse_args()
    texts = json.loads(args.input.read_text(encoding="utf-8"))
    if not isinstance(texts, list) or not texts or not all(isinstance(t, str) for t in texts):
        parser.error("input must be a nonempty JSON array of strings")
    if len(texts) > 10000 or sum(map(len, texts)) > 500000:
        parser.error("chapter exceeds synthesis limits")
    synthesize(texts, args.voice, args.audio, args.marks)


if __name__ == "__main__":
    main()
