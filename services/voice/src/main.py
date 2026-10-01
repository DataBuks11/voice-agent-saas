import logging
import os
from voice_agent.pipeline import VoicePipeline, VoiceConfig
from voice_agent.providers import StubSTT, StubLLM, StubTTS

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("voice.main")


def main() -> None:
    cfg = VoiceConfig(
        allow_barge_in=os.getenv("VOICE_ALLOW_BARGE_IN", "true").lower() == "true",
        max_turns=int(os.getenv("VOICE_MAX_CONVERSATION_TURNS", "50")),
        sample_rate=int(os.getenv("VOICE_AUDIO_SAMPLE_RATE", "16000")),
    )
    pipe = VoicePipeline(StubSTT(), StubLLM(), StubTTS(), cfg)
    log.info("voice pipeline ready (stub providers; set STT/LLM/TTS keys for real). barge_in=%s", cfg.allow_barge_in)
    _ = pipe


if __name__ == "__main__":
    main()
