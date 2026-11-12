import { useEffect } from 'react';
import { api } from '../api';
import { autosaveTick, confirmDiscard, loadSettings } from '../actions';
import { store, useStore } from '../store';
import { Editor } from './Editor';
import { Home } from './Home';
import { ModalHost, Toasts } from './Overlays';

export function App() {
  const screen = useStore((s) => s.screen);
  const autosave = useStore((s) => s.settings?.autosaveSeconds ?? 60);

  useEffect(() => {
    void loadSettings();
    void api.tasks.list().then((list) => store.set({ tasks: Object.fromEntries(list.map((t) => [t.id, t])) }));
    const offTasks = api.tasks.onChanged((t) => {
      if (!t) return void api.tasks.list().then((list) => store.set({ tasks: Object.fromEntries(list.map((x) => [x.id, x])) }));
      store.set((s) => ({ tasks: { ...s.tasks, [t.id]: t } }));
    });
    const offClose = api.window.onCloseRequested(async () => {
      if (await confirmDiscard()) await api.window.confirmClose();
    });
    return () => {
      offTasks();
      offClose();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => void autosaveTick(), autosave * 1000);
    return () => clearInterval(id);
  }, [autosave]);

  return (
    <>
      {screen === 'home' ? <Home /> : <Editor />}
      <ModalHost />
      <Toasts />
    </>
  );
}
