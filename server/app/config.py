from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    elevenlabs_api_key: str = ""
    elevenlabs_agent_id: str = ""
    elevenlabs_webhook_secret: str = ""

    xai_api_key: str = ""
    xai_model: str = "grok-4-fast-reasoning"

    zep_api_key: str = ""
    tavily_api_key: str = ""

    tool_secret: str = ""
    """Shared secret the ElevenLabs agent sends on server tool calls."""

    session_secret: str = ""
    """Key that signs device tokens. Unset means a per-process key: tokens die on restart."""

    state_file: str = ".state/calls.json"
    """Where call timestamps survive a restart."""

    allowed_origins: str = ""
    checkin_hour_utc: int = 7
    """Hour of day the proactive scheduler evaluates every runner."""

    scheduler_enabled: bool = True

    @property
    def origins(self) -> list[str]:
        """No configured origins means same-origin only, never `*`."""
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
