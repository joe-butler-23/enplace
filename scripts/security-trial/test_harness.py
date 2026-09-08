"""Executed safety controls for the trial runner itself; no model calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("trial", Path(__file__).with_name("run.py"))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class AssessmentSafety(unittest.TestCase):
    def test_helper_deadline_kills_and_reaps_stalled_process(self):
        with tempfile.TemporaryDirectory() as directory:
            pidfile = Path(directory) / "pid"
            program = "require('node:fs').writeFileSync(" + json.dumps(str(pidfile)) + ", String(process.pid)); setInterval(() => {}, 10000);"
            with self.assertRaises(subprocess.TimeoutExpired):
                trial.run([str(trial.NODE.resolve()), "-e", program], timeout=1)
            # The child publishes its own PID; elapsed time is not evidence of
            # readiness or cleanup. A still-running child fails this check.
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_planted_helper_replacement_cannot_execute_during_assessment(self):
        with tempfile.TemporaryDirectory(prefix="enplace-harness-owner-") as owner:
            owner = Path(owner)
            bundle = owner / "engine.mjs"
            trial.run([str(trial.ROOT / "node_modules/.bin/esbuild"),
                       "scripts/security-trial/fixture-entry.ts", "--bundle", "--platform=node", "--format=esm",
                       "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
                       f"--outfile={bundle}"], cwd=trial.ROOT)
            with tempfile.TemporaryDirectory(prefix="enplace-harness-subject-") as subject:
                work = Path(subject)
                _, before = trial.setup(work, bundle, "import", "clean")
                sentinel = owner / "outside-sentinel"
                sentinel.write_text("untouched")
                planted = work / ".fixture/engine.mjs"
                planted.write_text("import {writeFileSync} from 'node:fs'; writeFileSync(" + json.dumps(str(sentinel)) + ", 'EXECUTED'); console.log('{}');")
                # Fired-once control: the removed host-execution pattern really
                # runs subject-controlled code. Target is only this fake sentinel.
                trial.run([str(trial.NODE.resolve()), str(planted), "dump"], cwd=work)
                self.assertEqual(sentinel.read_text(), "EXECUTED")
                sentinel.write_text("untouched")
                actual = trial.assess(work, bundle, before, "import", [])
                self.assertEqual(actual["after"], before)
                self.assertEqual(sentinel.read_text(), "untouched")
                # A subject-created state symlink must not be followed by the
                # host-owned reader into its owner's filesystem.
                state = work / ".fixture/book.yjs"
                state.unlink()
                state.symlink_to(sentinel)
                with self.assertRaises(RuntimeError):
                    trial.assess(work, bundle, before, "import", [])
                self.assertEqual(sentinel.read_text(), "untouched")

    def test_evidence_symlinks_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            work = Path(root) / "work"
            (work / ".fixture").mkdir(parents=True)
            outside = Path(root) / "outside"
            outside.write_text("synthetic private data")
            (work / ".fixture/operations.jsonl").symlink_to(outside)
            with self.assertRaises(OSError):
                trial.fixture_text(work, "operations.jsonl")
            fifo = work / ".fixture/ptt-attempts.txt"
            os.mkfifo(fifo)
            with self.assertRaises(RuntimeError):
                trial.fixture_text(work, "ptt-attempts.txt")


if __name__ == "__main__": unittest.main()
