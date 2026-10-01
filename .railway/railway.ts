import { defineRailway, github, preserve, project, service } from "railway/iac";

export default defineRailway(() => {
  const voiceAgentSaas = service("voice-agent-saas", {
    source: github("DataBuks11/voice-agent-saas", { checkSuites: false }),
    replicas: { "sfo": 1 },
    env: { DATABASE_URL: preserve(), LOG_LEVEL: preserve(), SUPABASE_ANON_KEY: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve(), SUPABASE_URL: preserve() },
  });

  return project("voice-agent-saas", {
    resources: [voiceAgentSaas],
  });
});
