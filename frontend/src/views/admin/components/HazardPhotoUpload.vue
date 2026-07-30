<template>
  <div class="photo-upload">
    <div class="thumb-grid">
      <!-- 已上传缩略图 -->
      <div v-for="(url, i) in modelValue" :key="i" class="thumb">
        <img :src="url" alt="隐患照片" />
        <button type="button" class="thumb-del" @click="removeAt(i)" title="删除">
          <Icon name="x" :size="14" />
        </button>
      </div>

      <!-- 上传中占位 -->
      <div v-for="n in uploadingCount" :key="'up' + n" class="thumb uploading">
        <div class="spinner"></div>
      </div>

      <!-- 添加按钮 -->
      <label v-if="modelValue.length + uploadingCount < max" class="thumb add" :class="{ disabled: uploading }">
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          multiple
          hidden
          @change="onChange"
        />
        <Icon name="camera" :size="22" />
        <span class="add-text">上传照片</span>
      </label>
    </div>
    <p v-if="modelValue.length" class="photo-count">已上传 {{ modelValue.length }} 张</p>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Icon from '@/components/Icon.vue'
import { uploadHazardPhoto } from '@/api/hazard'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  photoType: { type: String, default: 'report' },
  max: { type: Number, default: 9 },
})
const emit = defineEmits(['update:modelValue'])

const fileInput = ref(null)
const uploading = ref(false)
const uploadingCount = ref(0)

function removeAt(index) {
  const next = [...props.modelValue]
  next.splice(index, 1)
  emit('update:modelValue', next)
}

async function onChange(e) {
  const files = Array.from(e.target.files || [])
  if (!files.length) return
  // 重置 input，允许重复选择同一文件
  e.target.value = ''

  const remain = props.max - props.modelValue.length - uploadingCount.value
  const toUpload = files.slice(0, Math.max(0, remain))
  if (!toUpload.length) return

  uploading.value = true
  uploadingCount.value = toUpload.length
  const added = []
  try {
    for (const file of toUpload) {
      const res = await uploadHazardPhoto(file, props.photoType)
      const url = res.data?.data?.url
      if (url) added.push(url)
    }
  } catch (err) {
    alert('照片上传失败：' + (err.response?.data?.error || err.message))
  } finally {
    uploadingCount.value = 0
    uploading.value = false
    if (added.length) {
      emit('update:modelValue', [...props.modelValue, ...added])
    }
  }
}
</script>

<style scoped>
.photo-upload { width: 100%; }
.thumb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: 10px;
}
.thumb {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 12px;
  overflow: hidden;
  background: var(--c-surface-2);
  border: 1px solid var(--c-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--c-text-3);
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.thumb.uploading { border-style: dashed; }
.thumb-del {
  position: absolute;
  top: 4px; right: 4px;
  width: 22px; height: 22px;
  border: none; border-radius: 50%;
  background: rgba(10, 19, 34, .6);
  color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.thumb-del:hover { background: var(--c-danger); }
.thumb.add {
  cursor: pointer;
  flex-direction: column;
  gap: 4px;
  color: var(--c-blue-600);
  border: 2px dashed var(--c-border-strong);
  transition: border-color .15s ease, background .15s ease;
}
.thumb.add:hover { border-color: var(--c-blue-600); background: var(--c-blue-50); }
.thumb.add.disabled { opacity: .5; cursor: not-allowed; }
.add-text { font-size: 12px; font-weight: 500; }
.photo-count { font-size: 12px; color: var(--c-text-3); margin-top: 8px; }
</style>
