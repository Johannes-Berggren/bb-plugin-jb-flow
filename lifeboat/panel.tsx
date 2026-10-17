import { useState } from "react";
import {
  experimental_useProviders as useProviders,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useLifeboatData } from "./hooks";
import { LifeboatView } from "./view";

export function LifeboatPanel({ subPath = "" }: { subPath?: string } = {}) {
  const navigate = useBbNavigate();
  const { providers } = useProviders();
  const [selected, setSelected] = useState<{ path: string; id: string }>();
  const match = /^host\/([^/]+)$/.exec(subPath);
  const requested = selected?.path === subPath ? selected.id : match?.[1];
  const data = useLifeboatData(requested);
  const providerNames = {
    claude: providers.find((provider) => provider.id === "claude-code")
      ?.displayName,
    codex: providers.find((provider) => provider.id === "codex")?.displayName,
  };
  return (
    <LifeboatView
      hosts={data.hosts}
      hostId={data.hostId}
      onHostChange={(id) => setSelected({ path: subPath, id })}
      snapshot={data.snapshot}
      busy={data.busy}
      loading={data.loading}
      error={data.error}
      setupRequired={data.setupRequired}
      now={data.now}
      providerNames={providerNames}
      onOperation={data.run}
      onStudio={() => navigate.toPluginPanel("studio")}
    />
  );
}
