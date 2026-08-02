<template>
  <Teleport to="body">
    <div v-if="visible" class="preview-overlay" @click.self="$emit('cancel')">
      <div class="preview-modal">
        <!-- 加载态：全屏 spinner -->
        <div v-if="loading" class="preview-loading">
          <div class="spinner"></div>
          <p class="loading-text">{{ loadingText }}</p>
        </div>

        <!-- 正常态 -->
        <template v-else>
          <!-- 标题区 -->
          <div class="preview-header">
            <div class="header-left">
              <h3 class="header-title">{{ title || '题目预览' }}</h3>
              <span class="difficulty-badge" :class="'diff-' + difficulty">
                {{ ['', 'Lv.1 基础', 'Lv.2 基础', 'Lv.3 应用', 'Lv.4 深入', 'Lv.5 深入'][difficulty] || 'Lv.3 应用' }}
              </span>
              <span class="count-badge">共 {{ questions.length }} 题</span>
            </div>
            <button class="close-btn" @click="$emit('cancel')">&times;</button>
          </div>

          <!-- 题目列表（滚动） -->
          <div class="preview-body" ref="scrollBody">
            <div
              v-for="(q, idx) in questions"
              :key="idx"
              class="question-card"
            >
              <!-- 卡头：题型 + 题号 -->
              <div class="q-header">
                <span class="q-type-badge" :class="'type-' + (q.type || 'single')">
                  {{ typeLabel(q.type) }}
                </span>
                <span class="q-number">第 {{ idx + 1 }} 题</span>
              </div>

              <!-- 题干 -->
              <div class="q-stem">{{ q.question }}</div>

              <!-- 选项 -->
              <div v-if="q.options && q.options.length > 0" class="q-options">
                <div
                  v-for="(opt, oi) in q.options"
                  :key="oi"
                  class="q-option"
                  :class="{ 'is-correct': isCorrectAnswer(q, opt, oi) }"
                >
                  <span class="opt-letter">{{ optionLetters[oi] }}</span>
                  <span class="opt-text">{{ opt.label || opt.text || opt }}</span>
                  <span v-if="isCorrectAnswer(q, opt, oi)" class="correct-mark">&#10003;</span>
                </div>
              </div>

              <!-- 解析 -->
              <div v-if="q.explanation || q.analysis" class="q-analysis">
                <span class="analysis-label">解析：</span>
                {{ q.explanation || q.analysis }}
              </div>
            </div>
          </div>

          <!-- 底部操作栏 -->
          <div class="preview-footer">
            <button class="btn btn-text" @click="$emit('cancel')">取消</button>
            <button class="btn btn-outline" @click="$emit('regenerate')">重新生成</button>
            <button class="btn btn-primary" @click="$emit('confirm')">确认保存</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  visible: { type: Boolean, default: false },
  questions: { type: Array, default: () => [] },
  title: { type: String, default: '' },
  difficulty: { type: Number, default: 3 },
  loading: { type: Boolean, default: false },
  loadingText: { type: String, default: 'AI 正在生成题目，请稍候…' },
})

defineEmits(['confirm', 'regenerate', 'cancel'])

const optionLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']

function typeLabel(type) {
  const map = {
    single: '单选题',
    multiple: '多选题',
    judge: '判断题',
    fill: '填空题',
    essay: '简答题',
    multiple_image: '图片题',
  }
  return map[type] || type || '单选题'
}

function isCorrectAnswer(q, opt, optIndex) {
  if (!q.answer) return false
  const answer = String(q.answer).trim()
  const optVal = opt.value !== undefined ? String(opt.value).trim() : optionLetters[optIndex]
  if (q.type === 'multiple' || q.type === 'multiple_image') {
    // 多选题：answer 可能是 "ABC" 或 ["A","B","C"] 或 "A,B,C"
    const answers = Array.isArray(q.answer)
      ? q.answer
      : answer.split('').map((c) => c.trim()).filter(Boolean)
    return answers.includes(optVal) || answers.includes(optionLetters[optIndex])
  }
  // 单选题/判断题：单个字母或文本匹配
  return answer === optVal || answer === optionLetters[optIndex]
}
</script>

<style scoped>
/* ── 遮罩层 ── */
.preview-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* ── 弹窗 ── */
.preview-modal {
  background: #fff;
  border-radius: 12px;
  width: 100%;
  max-width: 720px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}

/* ── 加载态 ── */
.preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 40px;
  gap: 20px;
}

.spinner {
  width: 44px;
  height: 44px;
  border: 4px solid #e0e0e0;
  border-top-color: #1a73e8;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  color: #5f6368;
  font-size: 15px;
  margin: 0;
}

/* ── 标题区 ── */
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 24px;
  border-bottom: 1px solid #e8eaed;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.header-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
  color: #202124;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.difficulty-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.diff-1, .diff-2 { background: #e6f4ea; color: #137333; }
.diff-3 { background: #e8f0fe; color: #1a73e8; }
.diff-4, .diff-5 { background: #fce8e6; color: #c5221f; }

.count-badge {
  font-size: 12px;
  color: #5f6368;
  background: #f1f3f4;
  padding: 2px 10px;
  border-radius: 10px;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  color: #5f6368;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}
.close-btn:hover { color: #202124; }

/* ── 题目列表 ── */
.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.question-card {
  border: 1px solid #e8eaed;
  border-radius: 10px;
  padding: 16px;
  background: #fafafa;
}

/* 卡头 */
.q-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.q-type-badge {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
}
.type-single { background: #e8f0fe; color: #1a73e8; }
.type-multiple { background: #fce8e6; color: #c5221f; }
.type-judge { background: #e6f4ea; color: #137333; }
.type-fill { background: #fef7e0; color: #e37400; }
.type-essay { background: #f1f3f4; color: #5f6368; }
.type-multiple_image { background: #f3e8fd; color: #7c3aed; }

.q-number {
  font-size: 12px;
  color: #5f6368;
}

/* 题干 */
.q-stem {
  font-size: 14px;
  color: #202124;
  line-height: 1.6;
  margin-bottom: 10px;
  white-space: pre-wrap;
}

/* 选项 */
.q-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.q-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  background: #fff;
  border: 1px solid #e8eaed;
  transition: background 0.15s;
}

.q-option.is-correct {
  background: #e6f4ea;
  border-color: #34a853;
}

.opt-letter {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #f1f3f4;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: #5f6368;
  flex-shrink: 0;
}

.q-option.is-correct .opt-letter {
  background: #34a853;
  color: #fff;
}

.opt-text {
  flex: 1;
  color: #202124;
}

.correct-mark {
  color: #34a853;
  font-size: 16px;
  font-weight: 700;
  flex-shrink: 0;
}

/* 解析 */
.q-analysis {
  font-size: 13px;
  color: #5f6368;
  background: #f1f3f4;
  border-radius: 6px;
  padding: 10px 12px;
  line-height: 1.5;
}

.analysis-label {
  font-weight: 500;
  color: #3c4043;
}

/* ── 底部操作栏 ── */
.preview-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  padding: 14px 24px;
  border-top: 1px solid #e8eaed;
  flex-shrink: 0;
}

.btn {
  padding: 8px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: background 0.15s, box-shadow 0.15s;
}

.btn-text {
  background: none;
  color: #5f6368;
}
.btn-text:hover { background: #f1f3f4; }

.btn-outline {
  background: #fff;
  border: 1px solid #dadce0;
  color: #1a73e8;
}
.btn-outline:hover { background: #f1f3f4; }

.btn-primary {
  background: #1a73e8;
  color: #fff;
}
.btn-primary:hover { background: #1557b0; box-shadow: 0 1px 4px rgba(26,115,232,0.3); }
</style>
