// Test fixture: two example workspaces matched by project and plugin names.
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
    make("hitlight", "HitLight", (name) => /hitl(?:ight|aight)/.test(name), [
      "hitlight-devops",
      "release-train",
      "runner-monitor",
    ]),
    make(
      "findable",
      "Findable",
      (name) =>
        /findable/.test(name) ||
        ["monorepo-apps", "monorepo-ai", "infrastructure_v2"].includes(name),
      ["findable-devops", "findable-team"],
    ),
  ];
}
