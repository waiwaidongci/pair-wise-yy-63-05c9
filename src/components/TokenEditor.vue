<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as monaco from 'monaco-editor';

const props = defineProps<{ modelValue: string; language?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const host = ref<HTMLElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let applyingExternal = false;

onMounted(() => {
  if (!host.value) return;
  editor = monaco.editor.create(host.value, {
    value: props.modelValue,
    language: props.language ?? 'json',
    theme: 'vs-light',
    minimap: { enabled: false },
    lineNumbers: 'on',
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    fontSize: 12,
    tabSize: 2,
    automaticLayout: true,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 12 }
  });
  editor.onDidChangeModelContent(() => {
    if (!applyingExternal && editor) emit('update:modelValue', editor.getValue());
  });
});

watch(() => props.modelValue, (value) => {
  if (!editor || editor.getValue() === value) return;
  applyingExternal = true;
  editor.setValue(value);
  applyingExternal = false;
});

onBeforeUnmount(() => editor?.dispose());
</script>

<template><div ref="host" class="monaco-host" /></template>

<style scoped>
.monaco-host { width: 100%; height: 100%; min-height: 330px; }
</style>
