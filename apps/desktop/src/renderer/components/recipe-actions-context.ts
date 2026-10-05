import { createContext } from "react";
import type { TaskRecipe } from "@vela/shared";
import type { RecipeMessageSeed } from "./TaskRecipesPage";

// Keep the context outside component modules so Fast Refresh retains the same
// provider/consumer identity when recipe UI components are edited.
export const RecipeActionsContext = createContext<{
  conversationId: string | null;
  open: () => void;
  useRecipe?: (recipe: TaskRecipe) => void;
  fromMessage: (seed: RecipeMessageSeed) => void;
} | null>(null);
