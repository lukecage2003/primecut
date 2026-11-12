import type { PrimestoneApi } from '../shared/api';

declare global {
  interface Window {
    primestone: PrimestoneApi;
  }
}

export const api: PrimestoneApi = window.primestone;
