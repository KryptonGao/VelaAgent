import { createContext } from "react";
import type { AskUserQuestionRequest } from "@vela/shared";

/** Question changes must reach memoized tool rows without invalidating history. */
export const QuestionContext = createContext<AskUserQuestionRequest | null>(null);
