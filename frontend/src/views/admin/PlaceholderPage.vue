<template>
  <div class="placeholder-wrap">
    <div class="placeholder-card">
      <div class="ph-icon">
        <svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6z" />
          <line x1="14.5" y1="9.5" x2="14.5" y2="9.5" />
        </svg>
      </div>
      <div class="ph-badge">预留栏目</div>
      <h1 class="ph-title">{{ title }}</h1>
      <p class="ph-desc">{{ desc }}</p>
      <p class="ph-hint">该栏目已在左侧目录树预留，功能开发中，敬请期待。</p>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const title = computed(() => route.meta?.title || '模块')
const desc = computed(
  () => route.meta?.desc || '该栏目已预留，功能开发中，敬请期待。'
)
</script>

<style scoped>
.placeholder-wrap {
  min-height: calc(100vh - 60px - 48px);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.placeholder-card {
  width: 100%; max-width: 520px;
  background: var(--c-surface, #fff);
  border: 1px solid var(--c-border, #e5e9f0);
  border-radius: 16px;
  padding: 48px 36px;
  text-align: center;
  box-shadow: 0 12px 32px rgba(16, 30, 54, .06);
}
.ph-icon {
  width: 84px; height: 84px; margin: 0 auto 18px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 22px;
  background: rgba(46, 139, 214, .1);
  color: var(--c-blue-500, #2e8bd6);
}
.ph-badge {
  display: inline-block;
  font-size: 12px; font-weight: 600; letter-spacing: 1px;
  color: #ffc53d; background: rgba(255, 197, 61, .12);
  padding: 4px 12px; border-radius: 999px; margin-bottom: 14px;
}
.ph-title {
  font-size: 22px; font-weight: 700; color: var(--c-text, #1b2a44);
  margin: 0 0 10px; letter-spacing: .5px;
}
.ph-desc {
  font-size: 14.5px; color: var(--c-text-2, #5b6b85); line-height: 1.7;
  margin: 0 0 16px;
}
.ph-hint {
  font-size: 12.5px; color: var(--c-text-3, #93a0b5);
  margin: 0; padding-top: 16px; border-top: 1px dashed var(--c-border, #e5e9f0);
}
</style>
