/// <reference types="vite/client" />

import type { VelaApi } from "@vela/shared";

declare global {
  interface Window {
    vela?: VelaApi;
  }
}

export {};
