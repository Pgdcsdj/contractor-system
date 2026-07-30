<template>
  <div id="app">
    <!-- 网络状态 Banner -->
    <div :class="['net-banner', { offline: !isOnline }]">
      {{ isOnline ? '✓ 网络已连接' : '⚠ 当前离线，答题记录将在联网后自动上传' }}
    </div>

    <router-view v-slot="{ Component }">
      <transition name="page" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const isOnline = ref(navigator.onLine)

function handleOnline()  { isOnline.value = true }
function handleOffline() { isOnline.value = false }

onMounted(() => {
  window.addEventListener('online',  handleOnline)
  window.addEventListener('offline', handleOffline)
})
onUnmounted(() => {
  window.removeEventListener('online',  handleOnline)
  window.removeEventListener('offline', handleOffline)
})
</script>

<style>
.page-enter-active,
.page-leave-active {
  transition: opacity 0.2s ease;
}
.page-enter-from,
.page-leave-to {
  opacity: 0;
}
</style>
