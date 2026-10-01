import { expect, test } from "bun:test"
import { agentDisplayName, displayName } from "../src/util/display-name"

test("replaces plugin display names and role suffixes", () => {
  const labels = {
    "Sisyphus - ultraworker": "Code",
    "Hephaestus - Deep Agent": "Deep work",
    "Prometheus - Plan Builder": "Plan",
    "Atlas - Plan Executor": "Execute",
    "Sisyphus-Junior": "Worker",
    "Metis - Plan Consultant": "Consult",
    "Momus - Plan Critic": "Review",
    "Athena - Council": "Team review",
    "Athena-Junior - Council": "Reviewer",
    oracle: "Advisor",
    librarian: "Research",
    "multimodal-looker": "Vision",
  }
  for (const [name, label] of Object.entries(labels)) expect(displayName(name)).toBe(label)
})

test("removes branding in command titles and descriptions", () => {
  expect(displayName("Oh My OpenCode: Sisyphus mode")).toBe("Tools: Code mode")
  expect(displayName("oh-my-openagent / OMO settings")).toBe("Tools / Tools settings")
})

test("does not change custom agents or substrings", () => {
  expect(displayName("custom-reviewer")).toBe("custom-reviewer")
  expect(displayName("my-atlasdb-tool")).toBe("my-atlasdb-tool")
})

test("capitalizes agent labels without changing the rest of a custom name", () => {
  for (const [name, label] of Object.entries({
    artistry: "Artistry",
    "deep-high": "Deep-high",
    "deep-low": "Deep-low",
    quick: "Quick",
    "unspecified-low": "Unspecified-low",
    writing: "Writing",
    "custom-reviewer": "Custom-reviewer",
    "iOS-reviewer": "IOS-reviewer",
    "  build": "  Build",
    "Sisyphus - ultraworker": "Code",
    "": "",
  })) expect(agentDisplayName(name)).toBe(label)
  expect(displayName("a custom description")).toBe("a custom description")
})
