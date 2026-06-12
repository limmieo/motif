#!/usr/bin/env python
"""Long-lived transcription worker.

Reads one JSON request per line from stdin ({"args": [...cli args...]}),
runs the audio_to_midi pipeline, and answers with a RESULT line on stdout.
Heavy imports happen once at startup and neural models stay cached between
jobs, so repeat transcriptions skip ~15 seconds of setup each.
"""

from __future__ import annotations

import json
import sys
import traceback

import audio_to_midi


def warm_up() -> None:
    """Pay the heavy import cost once, before the first job arrives."""
    try:
        import librosa  # noqa: F401
        import pretty_midi  # noqa: F401
        import torch  # noqa: F401
    except Exception as error:
        print(f"Worker warm-up failed: {error}", file=sys.stderr, flush=True)


def respond(ok: bool, error: str | None = None) -> None:
    payload: dict = {"ok": ok}
    if error:
        payload["error"] = error
    print("RESULT " + json.dumps(payload, ensure_ascii=True), flush=True)


def main() -> int:
    warm_up()
    parser = audio_to_midi.build_parser()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            raw_args = [str(value) for value in request["args"]]
            try:
                args = parser.parse_args(raw_args)
            except SystemExit:
                respond(False, "Invalid transcription arguments.")
                continue
            audio_to_midi.run_pipeline(args)
            respond(True)
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            respond(False, str(error) or "Transcription failed.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
