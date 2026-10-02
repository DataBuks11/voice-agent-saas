"""Voice runtime entrypoint: WebSocket STT/LLM/TTS loop (open-source, keyless)."""
import logging
import os

from voice_agent.server import run

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


def main() -> None:
    run()


if __name__ == "__main__":
    main()
