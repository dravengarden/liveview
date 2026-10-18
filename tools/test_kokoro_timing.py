"""Timing invariants; no model, network, or optional Python packages needed."""
import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location("kokoro_adapter", Path(__file__).with_name("kokoro-tts.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class TimingTest(unittest.TestCase):
    def test_chunk_limit_keeps_every_source_token(self):
        tokens = [SimpleNamespace(phonemes="a" * 50, whitespace=" ") for _ in range(21)]
        chunks = list(adapter.bounded_token_chunks(tokens))
        self.assertEqual([id(t) for chunk in chunks for t in chunk], [id(t) for t in tokens])
        self.assertTrue(all(sum(len(t.phonemes) + bool(t.whitespace) for t in chunk) <= 510 for chunk in chunks))
        with self.assertRaises(ValueError):
            list(adapter.bounded_token_chunks([SimpleNamespace(phonemes="a" * 511, whitespace="")]))
        boundary = SimpleNamespace(phonemes="a" * 510, whitespace=" ")
        self.assertEqual(list(adapter.bounded_token_chunks([boundary])), [[boundary]])

    def test_silent_divider_does_not_steal_sentence_duration(self):
        marks = adapter.unit_marks([0.2, None, 3.0, None], 5000)
        self.assertEqual(marks, [
            {"idx": 0, "start_ms": 200, "end_ms": 3000},
            {"idx": 1, "start_ms": 3000, "end_ms": 3000},
            {"idx": 2, "start_ms": 3000, "end_ms": 5000},
            {"idx": 3, "start_ms": 5000, "end_ms": 5000},
        ])

    def test_decoder_rounding_is_bounded(self):
        marks = adapter.unit_marks([None, 0.2505, 99], 1000)
        self.assertEqual(len(marks), 3)
        self.assertTrue(all(0 <= m["start_ms"] <= m["end_ms"] <= 1000 for m in marks))
        self.assertEqual(marks[0]["start_ms"], marks[0]["end_ms"])


if __name__ == "__main__":
    unittest.main()
