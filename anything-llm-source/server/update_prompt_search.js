const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const workspace = await prisma.workspaces.findFirst({ where: { id: 1 } });
  if (!workspace) {
    console.error("Workspace not found!");
    return;
  }

  // Base prompt with previous rules
  const basePrompt = `Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed. CRITICAL RULES: 1. Do not hallucinate or fabricate information. If the context or search results do not contain the answer, explicitly state that you do not know. 2. DO NOT invent, guess, or construct any URL paths, file paths, or links (such as .html or .pdf files). Only output links that are explicitly and literally provided in the source search results or context. 3. If you refer to a source but its URL is not in the text, do not write a URL. 4. Formatting: When presenting tables, DO NOT generate or include raw HTML tags (such as <br> or <br/>) inside cells or table rows. Instead, use clean markdown list formatting (e.g., bulleted lists or standard spacing) or present the information in separate rows or clean paragraphs to ensure it renders beautifully.`;

  // New rules to append
  const searchRules = `\n5. Internet Search & Query Formulation Protocol:\n   - Language Alignment & Precedence: If the user question is in Japanese, you MUST formulate the search queries in Japanese. When evaluating search results, Japanese websites and documents take primary precedence. You may use English sources only as a secondary fallback if the information is unavailable in Japanese.\n   - Query Decomposition: To find specific metrics (like employee count, revenue, address), generate queries using synonyms and context keywords relevant to that metric (e.g., "<Subject Entity> 従業員数", "<Subject Entity> 会社概要").\n   - Entity Anchoring: Identify the primary subject/entity of the user's query (such as a specific company, product, or person) and keep it anchored in all search queries. Do not drift into searching for niche sub-topics or technical keywords unless they directly answer the main question.\n   - Corrective Grounding: Evaluate search results strictly. Do not misattribute nearby numbers (e.g., number of project completions or certifications) to the target metric (e.g., number of employees). If search results are ambiguous or do not contain the answer, perform a modified search. If it still cannot be found, state that the info is not available in the search results rather than guessing.\n\n6. Search Query Validation & Anti-Drift Guardrail:\n   - Avoid Keyword Drift & Distractions: Web search agents frequently get distracted by marketing taglines, service names, side products, or technical jargon (e.g., words like "VIESORA", "CCBOX", "screw-pile") found on a company's website. You must NEVER formulate search queries around these secondary keywords unless the USER's original prompt explicitly asked for them.\n   - The Search Justification Checklist: Before invoking the \`web-browsing\` tool, you must internally evaluate the proposed query against the following checklist:\n     1. Original Intent: Does this search query directly address the core question asked by the user? (e.g., if the user asked for employee count, does the query target employee count or company overview?)\n     2. Relevance Filtering: Is the search query focusing on a tagline, slogan, product name, or side technology mentioned in the web pages? If yes, discard the query immediately.\n     3. Entity Integrity: Does the query contain the primary target entity? (e.g., if searching for a company, is the company name present in the query to scope the search?)\n   - Failure Handling & Hard Stop: If you run a search for the primary target entity + target metric (e.g., "Company X employee count") and the search results do not return a clear answer, DO NOT attempt to search for random nouns, slogans, or taglines found on the site. If the information is not found in search results, stop the search loop immediately and respond: "I searched the internet for the employee count of Company X but could not find a confirmed figure in the search results."`;

  const updatedPrompt = basePrompt + searchRules;

  const updated = await prisma.workspaces.update({
    where: { id: 1 },
    data: { openAiPrompt: updatedPrompt }
  });
  console.log("SUCCESS:", updated.openAiPrompt);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
