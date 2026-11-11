"""Recordings (voice memos, meetings) -> transcript -> goals.

WhisperX gives word-aligned segments and, with a HuggingFace token, speaker labels. Without
whisperx installed we fall back to faster-whisper (no speakers). Install: pip install 'jarvis-home[ingest]'.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path

from .config import Config
from .router import queue_snapshot
from .store import Store

log = logging.getLogger("jarvis.ingest")

INSTALL_HINT = "pip install 'jarvis-home[ingest]'"
MAX_TRANSCRIPT_CHARS = 150_000

EXTRACT_SCHEMA = {
    "type": "object",
    "properties": {
        "goals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short title (≤8 words)."},
                    "prompt": {"type": "string", "description": "Self-contained brief for an autonomous "
                                                                "agent, with all context from the recording."},
                    "done_criteria": {"type": "string", "description": "Concrete, checkable conditions."},
                },
                "required": ["title", "prompt", "done_criteria"],
                "additionalProperties": False,
            },
        },
        "summary": {"type": "string", "description": "Two or three plain sentences: what the recording "
                                                     "was about and what was decided."},
    },
    "required": ["goals", "summary"],
    "additionalProperties": False,
}

EXTRACT_SYSTEM = """\
You read transcripts of the owner's recordings (voice memos, meetings; speech-to-text, so expect
errors) for Jarvis, a home assistant that hands goals to autonomous agents working in a folder
with shell and web access.

Turn each concrete request or action item that the OWNER would want an agent to do into a goal.
Skip things assigned to other people, vague musings, and anything already in the queue.
Each goal needs a self-contained brief (the agent never sees the transcript) and done-criteria an
independent checker could verify (files exist, command output, tests pass). If an item is too vague
to define "done", make the first criterion "a written plan in PLAN.md the owner can approve".
No action items is a fine answer: return an empty list.
"""


# --- transcription -----------------------------------------------------------
def _hf_token(cfg: Config, hf_token: str | None) -> str | None:
    return (hf_token or getattr(cfg, "hf_token", "") or os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGINGFACE_TOKEN") or None)


def _model_name(cfg: Config) -> str:
    return getattr(cfg, "whisperx_model", "") or cfg.whisper_model


def _diarization_pipeline(whisperx):
    """whisperx.diarize.DiarizationPipeline (3.3+; 3.8.6 no longer re-exports it at top level),
    or whisperx.DiarizationPipeline on older releases."""
    try:
        from whisperx.diarize import DiarizationPipeline
        return DiarizationPipeline
    except ImportError:
        return getattr(whisperx, "DiarizationPipeline")


def _make_diarizer(Pipeline, token: str, device: str):
    """The auth kwarg is `token` in whisperx 3.4+ (checked against 3.8.6), `use_auth_token` before."""
    import inspect

    params = inspect.signature(Pipeline).parameters
    kw = "token" if "token" in params or "use_auth_token" not in params else "use_auth_token"
    return Pipeline(**{kw: token, "device": device})


def _ensure_punkt() -> None:
    """whisperx.align splits sentences with NLTK's punkt_tab, which pip doesn't install."""
    try:
        import nltk

        try:
            nltk.data.find("tokenizers/punkt_tab")
        except LookupError:
            nltk.download("punkt_tab", quiet=True)
    except Exception as e:  # noqa: BLE001 - alignment will just be skipped
        log.warning("could not fetch NLTK punkt_tab: %s", e)


def transcribe_with_whisperx(cfg: Config, path: str | Path, diarize: bool = False,
                             hf_token: str | None = None) -> list[dict]:
    """Segments [{start, end, text, speaker}] (speaker None without diarization)."""
    try:
        import whisperx
    except ImportError as e:
        raise RuntimeError(f"whisperx is not installed ({e}). Install it with: {INSTALL_HINT}") from e
    from .voice import resolve_device

    device, compute = resolve_device(cfg)
    audio = whisperx.load_audio(str(path))
    name = _model_name(cfg)
    model = whisperx.load_model(name, device, compute_type=compute,
                                language="en" if name.endswith(".en") else None)
    result = model.transcribe(audio, batch_size=16 if device == "cuda" else 4)
    language = result.get("language") or "en"
    _ensure_punkt()
    try:
        align_model, metadata = whisperx.load_align_model(language_code=language, device=device)
        result = whisperx.align(result["segments"], align_model, metadata, audio, device,
                                return_char_alignments=False)
    except Exception as e:  # noqa: BLE001 - alignment models don't exist for every language
        log.warning("whisperx alignment skipped: %s", e)
    token = _hf_token(cfg, hf_token)
    if diarize and not token:
        log.warning("diarization needs a HuggingFace token (hf_token / HF_TOKEN); skipping it")
    elif diarize:
        diarizer = _make_diarizer(_diarization_pipeline(whisperx), token, device)
        result = whisperx.assign_word_speakers(diarizer(audio), result)
    return [
        {"start": float(s.get("start") or 0.0), "end": float(s.get("end") or 0.0),
         "text": (s.get("text") or "").strip(), "speaker": s.get("speaker")}
        for s in result["segments"] if (s.get("text") or "").strip()
    ]


def transcribe_with_faster_whisper(cfg: Config, path: str | Path) -> list[dict]:
    from .voice import get_whisper, load_audio

    audio = load_audio(path)
    segments, _ = get_whisper(cfg).transcribe(audio if audio is not None else str(path),
                                              beam_size=5, vad_filter=True)
    return [{"start": s.start, "end": s.end, "text": s.text.strip(), "speaker": None}
            for s in segments if s.text.strip()]


def transcribe_recording(cfg: Config, path: str | Path, diarize: bool = False,
                         hf_token: str | None = None) -> list[dict]:
    try:
        import whisperx  # noqa: F401
    except ImportError:
        log.warning("whisperx not installed (%s); using faster-whisper without speaker labels",
                    INSTALL_HINT)
        return transcribe_with_faster_whisper(cfg, path)
    return transcribe_with_whisperx(cfg, path, diarize=diarize, hf_token=hf_token)


def format_transcript(segments: list[dict]) -> str:
    """Merge consecutive segments by speaker: 'SPEAKER_00: ...' lines (plain lines if unlabelled)."""
    lines: list[list] = []  # [speaker, text]
    for s in segments:
        spk, text = s.get("speaker"), (s.get("text") or "").strip()
        if not text:
            continue
        if lines and lines[-1][0] == spk:
            lines[-1][1] += " " + text
        else:
            lines.append([spk, text])
    return "\n".join(f"{spk}: {t}" if spk else t for spk, t in lines)


def save_transcript(cfg: Config, source: str | Path, text: str) -> Path:
    d = cfg.home / "transcripts"
    d.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^\w.-]+", "_", Path(source).stem)[:60] or "recording"
    out = d / f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}.txt"
    out.write_text(text + "\n")
    return out


# --- extraction --------------------------------------------------------------
async def extract_goals(cfg: Config, store: Store, transcript: str) -> dict:
    from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

    if len(transcript) > MAX_TRANSCRIPT_CHARS:
        transcript = transcript[:MAX_TRANSCRIPT_CHARS] + "\n[transcript truncated]"
    prompt = f"## Current queue\n{queue_snapshot(store)}\n\n## Transcript\n{transcript}"
    opts = ClaudeAgentOptions(
        model=cfg.router_model, effort="medium", system_prompt=EXTRACT_SYSTEM,
        tools=[], max_turns=3, max_budget_usd=1.0,
        output_format={"type": "json_schema", "schema": EXTRACT_SCHEMA},
        cwd=str(cfg.home),
    )
    out = None
    async for msg in query(prompt=prompt, options=opts):
        if isinstance(msg, ResultMessage):
            out = msg.structured_output
            if out is None and msg.result:
                m = re.search(r"\{.*\}", msg.result, re.S)
                out = json.loads(m.group(0)) if m else None
    if not out:
        raise RuntimeError("goal extraction returned nothing")
    return out


async def ingest(cfg: Config, store: Store, path: str | Path, diarize: bool = False,
                 hf_token: str | None = None) -> str:
    """Transcribe a recording, save the transcript, and queue a goal per action item."""
    import anyio

    path = Path(path).expanduser()
    if not path.exists():
        raise FileNotFoundError(path)
    segments = await anyio.to_thread.run_sync(
        lambda: transcribe_recording(cfg, path, diarize=diarize, hf_token=hf_token))
    transcript = format_transcript(segments)
    if not transcript:
        return f"I couldn't hear any speech in {path.name}."
    saved = save_transcript(cfg, path, transcript)
    store.log(None, "ingest", f"{path} -> {saved}")

    try:
        d = await extract_goals(cfg, store, transcript)
    except Exception as e:  # noqa: BLE001
        log.exception("extraction failed")
        return f"Transcript saved to {saved}, but I couldn't extract action items: {e}"

    created = []
    for g in d.get("goals") or []:
        title, prompt, done = (g.get("title") or "").strip(), (g.get("prompt") or "").strip(), \
            (g.get("done_criteria") or "").strip()
        if not prompt or not done:
            continue
        prompt += f"\n\n(From the recording {path.name}; full transcript: {saved})"
        created.append(store.add_goal(title or prompt[:60], prompt, done,
                                      cfg.default_budget_usd, cfg.max_attempts))
    summary = (d.get("summary") or "").strip()
    if created:
        items = "; ".join(f"#{g.id} {g.title}" for g in created)
        tail = f"Created {len(created)} goal{'s' if len(created) != 1 else ''}: {items}."
    else:
        tail = "No action items found."
    return " ".join(p for p in (summary, tail, f"Transcript: {saved}") if p)
