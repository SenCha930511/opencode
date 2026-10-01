// Presentation aliases only: plugin dispatch, stored messages and agent IDs stay intact.
const names: Record<string, string> = {
  "sisyphus-junior": "Worker",
  "athena-junior": "Reviewer",
  sisyphus: "Code",
  hephaestus: "Deep work",
  prometheus: "Plan",
  atlas: "Execute",
  metis: "Consult",
  momus: "Review",
  athena: "Team review",
  oracle: "Advisor",
  librarian: "Research",
  explore: "Explore",
  "multimodal-looker": "Vision",
  "council-member": "Reviewer",
}

export function displayName(text: string) {
  return text
    .replace(/\b(?:oh[ -]?my[ -]?(?:open(?:code|agent))|omo)\b/gi, "Tools")
    .replace(
      /\b(sisyphus-junior|athena-junior|sisyphus|hephaestus|prometheus|atlas|metis|momus|athena|oracle|librarian|explore|multimodal-looker|council-member)(?:\s*[-–]\s*(?:ultraworker|deep agent|plan builder|plan executor|plan consultant|plan critic|council))?\b/gi,
      (_, name: string) => names[name.toLowerCase()],
    )
}

export function agentDisplayName(name: string) {
  return displayName(name).replace(/^\s*\p{L}/u, (letter) => letter.toUpperCase())
}
