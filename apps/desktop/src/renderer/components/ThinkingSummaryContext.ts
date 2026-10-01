import { createContext } from "react";
import type { ThinkingSummariesApi } from "../hooks/useThinkingSummaries";

export const ThinkingSummaryContext = createContext<ThinkingSummariesApi | null>(null);
