import type {
  AppState,
  AuthMethodType,
  AuthNotice,
  AuthPromptRequest,
  CustomModelInput,
  ModelAuthEvent,
  ModelCatalog,
  ThinkingLevel,
} from "@vela/shared";
import { useCallback, useEffect, useState } from "react";

export interface LoginState {
  active: boolean;
  notices: AuthNotice[];
  progress: string | null;
  prompt: AuthPromptRequest | null;
  error: string | null;
}

const idleLogin: LoginState = {
  active: false,
  notices: [],
  progress: null,
  prompt: null,
  error: null,
};

export function useModels(setAppState: (state: AppState) => void) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [login, setLogin] = useState<LoginState>(idleLogin);

  const reload = useCallback(async () => {
    const api = window.vela;
    if (!api) return;
    try {
      setCatalog(await api.getCatalog());
      setCatalogError(null);
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : "无法读取模型");
    }
  }, []);

  useEffect(() => {
    const api = window.vela;
    if (!api) return;
    void reload();
    return api.onModelEvent((event) => {
      setLogin((current) => applyLoginEvent(current, event));
    });
  }, [reload]);

  const mutate = useCallback(async (task: () => Promise<AppState>, refreshCatalog: boolean) => {
    setActionError(null);
    try {
      setAppState(await task());
      if (refreshCatalog) await reload();
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "模型操作失败";
      setActionError(message);
      return message;
    }
  }, [reload, setAppState]);

  const select = useCallback((provider: string, id: string) => {
    const api = window.vela;
    if (!api) return Promise.resolve();
    return mutate(() => api.selectModel(provider, id), false);
  }, [mutate]);

  const setThinking = useCallback((level: ThinkingLevel) => {
    const api = window.vela;
    if (!api) return Promise.resolve();
    return mutate(() => api.setThinkingLevel(level), false);
  }, [mutate]);

  const add = useCallback((input: CustomModelInput) => {
    const api = window.vela;
    if (!api) return Promise.resolve("应用还没准备好");
    return mutate(() => api.addModel(input), true);
  }, [mutate]);

  const register = useCallback((input: CustomModelInput) => {
    const api = window.vela;
    if (!api) return Promise.resolve("应用还没准备好");
    return mutate(() => api.registerModel(input), true);
  }, [mutate]);

  const remove = useCallback((provider: string, id: string) => {
    const api = window.vela;
    if (!api) return Promise.resolve();
    return mutate(() => api.removeModel(provider, id), true);
  }, [mutate]);

  const logout = useCallback((providerId: string) => {
    const api = window.vela;
    if (!api) return Promise.resolve();
    return mutate(() => api.logout(providerId), true);
  }, [mutate]);

  const loginProvider = useCallback(async (providerId: string, type: AuthMethodType) => {
    const api = window.vela;
    if (!api) return;
    setActionError(null);
    setLogin({ ...idleLogin, active: true });
    try {
      const result = await api.login(providerId, type);
      setAppState(result.state);
      if (!result.cancelled) await reload();
      setLogin({ ...idleLogin });
    } catch (error) {
      setLogin((current) => ({
        ...current,
        active: true,
        error: error instanceof Error ? error.message : "登录失败",
        prompt: null,
      }));
    }
  }, [reload, setAppState]);

  const replyLogin = useCallback(async (promptId: string, value: string | null) => {
    const api = window.vela;
    if (!api) return;
    await api.replyLogin(promptId, value);
  }, []);

  const cancelLogin = useCallback(async () => {
    await window.vela?.cancelLogin();
  }, []);

  const dismissLogin = useCallback(() => {
    setLogin(idleLogin);
  }, []);

  return {
    catalog,
    catalogError,
    actionError,
    login,
    reload,
    select,
    setThinking,
    add,
    register,
    remove,
    logout,
    loginProvider,
    replyLogin,
    cancelLogin,
    dismissLogin,
  };
}

function applyLoginEvent(state: LoginState, event: ModelAuthEvent): LoginState {
  if (event.type === "cleared") {
    if (!state.active) return state;
    return { ...state, prompt: null };
  }
  if (event.type === "prompt") return { ...state, active: true, prompt: event.request };
  if (event.notice.type === "progress") return { ...state, active: true, progress: event.notice.message };
  return { ...state, active: true, notices: [...state.notices, event.notice].slice(-8) };
}
