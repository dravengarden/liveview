"""Timing invariants; no model, network, or optional Python packages needed."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("kokoro_adapter", Path(__file__).with_name("kokoro-tts.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class TimingTest(unittest.TestCase):
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
