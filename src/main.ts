import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import TDesign from 'tdesign-vue-next';
import 'tdesign-vue-next/es/style/index.css';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import router from './router';
import App from './App.vue';
import './styles.css';

(self as typeof self & { MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker: (_moduleId: string, label: string) => label === 'json' ? new jsonWorker() : new editorWorker()
};

createApp(App).use(createPinia()).use(router).use(VueQueryPlugin).use(TDesign).mount('#app');
