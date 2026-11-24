"""Local-only speech-to-text adapter for an explicitly installed whisper.cpp CLI.

No automatic model downloads, cloud uploads, or access to arbitrary directories.
This is an optional execution adapter, not a hosted inference service.
"""

from __future__ import annotations

from pathlib import Path
import shutil
import subprocess
import tempfile

SUPPORTED_MEDIA = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".mp4"}
MAX_MEDIA_BYTES = 200 * 1024 * 1024
MAX_TRANSCRIPT_CHARS = 50_000


class TranscriptionUnavailable(RuntimeError):
    pass


def _safe_local_file(value: str | Path, root: str | Path, *, extensions: set[str]):
    original = Path(value)
    path = original.resolve(strict=True)
    base = Path(root).resolve(strict=True)
    if not path.is_relative_to(base) or not path.is_file() or original.is_symlink():
        raise ValueError("file must be a regular file within the approved directory")
    if path.suffix.lower() not in extensions:
        raise ValueError("unsupported file extension")
    return path


def transcribe_local_media(media_path: str | Path, *, media_root: str | Path,
                           model_path: str | Path, model_root: str | Path,
                           executable: str = "whisper-cli", timeout: int = 180) -> str:
    if not 1 <= timeout <= 900:
        raise ValueError("invalid timeout")
    media = _safe_local_file(media_path, media_root, extensions=SUPPORTED_MEDIA)
    model = _safe_local_file(model_path, model_root, extensions={".bin"})
    if media.stat().st_size > MAX_MEDIA_BYTES:
        raise ValueError("media too large")
    if executable != "whisper-cli":
        raise ValueError("only audited local whisper-cli may be invoked")
    binary = shutil.which(executable)
    if binary is None:
        raise TranscriptionUnavailable("install whisper.cpp whisper-cli and a local model")
    with tempfile.TemporaryDirectory(prefix="orbitsuite-transcript-") as temp:
        prefix = str(Path(temp) / "transcript")
        # Passing an argument array with shell=False prevents command injection.
        try:
            subprocess.run([binary, "-m", str(model), "-f", str(media),
                            "-otxt", "-of", prefix, "-nt"],
                           cwd=temp, timeout=timeout, check=True,
                           capture_output=True, text=True)
        except (subprocess.SubprocessError, OSError) as err:
            raise TranscriptionUnavailable("local transcription failed or timed out") from err
        output = Path(prefix + ".txt")
        if not output.is_file():
            raise TranscriptionUnavailable("transcription output missing")
        return output.read_text(encoding="utf-8", errors="replace")[:MAX_TRANSCRIPT_CHARS].strip()
