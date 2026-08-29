from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    elevenlabs_api_key: str = ""
    elevenlabs_agent_id: str = ""
    elevenlabs_webhook_secret: str = ""

    xai_api_key: str = ""
    # A reasoning model spends seconds thinking before its first spoken word, and a
    # call is a conversation: ElevenLabs abandoned turns waiting for it.
    xai_model: str = "grok-4.20-0309-non-reasoning"

    zep_api_key: str = ""
    tavily_api_key: str = ""

    wearables_url: str = ""
    """Our own Open Wearables deployment. Unset means the coach has no device data."""
    wearables_api_key: str = ""
    wearables_webhook_secret: str = ""
    """Signs the sync webhooks. Unset means wearable payloads are refused."""

    tool_secret: str = ""
    """Shared secret the ElevenLabs agent sends on server tool calls."""

    session_secret: str = ""
    """Key that signs device tokens. Unset means a per-process key: tokens die on restart."""

    database_url: str = ""
    """Postgres holding call history and wearable data. Unset means memory only."""

    pwa_url: str = ""
    """Where the runner is sent back to after connecting a device."""

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
