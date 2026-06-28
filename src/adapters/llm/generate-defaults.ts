/**
 * Global cap on LLM output tokens for every agent.generate() call.
 * Passed as modelSettings.maxOutputTokens in Mastra 1.41.
 *
 * 16384 is well above any real profile / critique / verdict / builder output.
 * It cuts the default 65536 reservation 4× and fixes OpenRouter 402 errors
 * caused by over-reserving credits on expensive models.
 */
export const MAX_OUTPUT_TOKENS = 16384;
