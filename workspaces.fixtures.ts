// Test fixture: two made-up workspaces matched by project and plugin names.
import type { Workspace } from "./workspaces";

export function exampleWorkspaces(projects: readonly { id: string; name: string }[]): Workspace[] {
  const make = (
    id: string,
    name: string,
    matches: (name: string) => boolean,
    pluginIds: string[],
  ): Workspace => ({
    id,
    name,
    projectIds: projects
      .filter((project) => matches(project.name.toLowerCase()))
      .map((project) => project.id),
    sectionIds: [],
    pluginIds,
    sectionOrder: [],
  });
  return [
    make("acme", "Acme", (name) => /acme/.test(name), [
      "acme-devops",
      "release-train",
      "runner-monitor",
    ]),
    make(
      "globex",
      "Globex",
      (name) =>
        /globex/.test(name) ||
        ["globex-web", "globex-ai", "globex-infra"].includes(name),
      ["globex-devops", "globex-team"],
    ),
  ];
}
