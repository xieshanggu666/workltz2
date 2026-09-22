<template>
  <div class="wo" v-if="order || history.length">
    <!-- 发起抢修 -->
    <button v-if="!order && !history.length" class="wo-launch" @click="showCreate = !showCreate">
      🔧 发起道路抢修工单
    </button>
    <div v-if="!order && showCreate" class="wo-form create-box">
      <textarea v-model="createForm.description" rows="2" placeholder="抢修要求（可空），如：优先抢通半幅路面"></textarea>
      <div class="wf-row">
        <button class="ok" @click="onCreate">确认发起</button>
        <button @click="showCreate = false">取消</button>
      </div>
      <p v-if="msg" class="wo-msg err">{{ msg }}</p>
    </div>

    <template v-if="order">
      <!-- 工单头 -->
      <div class="wo-head">
        <span class="wo-badge" :style="{ background: stMeta.color }">{{ stMeta.label }}</span>
        <strong>道路抢修工单</strong>
        <span class="wo-id">{{ order.id.slice(-4) }}</span>
      </div>

      <!-- 待分配：分配队伍/车辆/物资 -->
      <template v-if="order.status === 'created'">
        <div class="wo-form">
          <label>来源基地</label>
          <select v-model="assignForm.baseId">
            <option v-for="b in cmd.bases" :key="b.id" :value="b.id">{{ b.name }}</option>
          </select>
          <div class="wf-grid">
            <div>
              <label>抢修队伍（人）<em>余 {{ baseStock('personnel') }}</em></label>
              <input type="number" min="1" v-model.number="assignForm.teamSize" />
            </div>
            <div>
              <label>车辆（辆）<em>余 {{ baseStock('vehicle') }}</em></label>
              <input type="number" min="1" v-model.number="assignForm.vehicleCount" />
            </div>
          </div>
          <label>抢修物资</label>
          <div class="mat-row" v-for="(m, i) in assignForm.materials" :key="m.type">
            <select v-model="m.type">
              <option v-for="t in materialOptions" :key="t" :value="t">{{ resMeta(t).label }}（余 {{ baseStock(t) }}）</option>
            </select>
            <input type="number" min="0" v-model.number="m.qty" placeholder="数量" />
            <button class="mat-del" @click="assignForm.materials.splice(i, 1)">✕</button>
          </div>
          <button class="mat-add" @click="addMatRow">＋ 添加物资</button>
          <div class="wf-row">
            <button class="ok" @click="onAssign">🧰 确认分配</button>
          </div>
        </div>
      </template>

      <!-- 待接单：现场接单 -->
      <template v-else-if="order.status === 'assigned'">
        <p class="wo-line">🧰 {{ order.baseName }}｜队伍 {{ order.teamSize }} 人 · 车辆 {{ order.vehicleCount }} 辆</p>
        <p class="wo-line" v-if="order.materials.length">📦 {{ order.materials.map((m) => `${m.typeLabel}${m.alloc}${m.unit}`).join('、') }}</p>
        <p class="wo-line muted">🚐 预计抵达+抢通 {{ order.eta?.distance }}km·{{ order.eta?.minutes }}min</p>
        <div class="wo-form inline">
          <input v-model="acceptName" placeholder="现场负责人（可空）" />
          <div class="wf-row">
            <button class="ok" @click="onAccept">🛻 现场接单</button>
          </div>
        </div>
      </template>

      <!-- 抢修中 / 已延期 / 待验收 -->
      <template v-else>
        <div class="wo-prog">
          <div class="wp-bar"><i :style="{ width: order.progress + '%', background: stMeta.color }"></i></div>
          <span>{{ order.progress }}%</span>
        </div>
        <p class="wo-line">🧰 {{ order.baseName }}｜{{ order.teamSize }}人·{{ order.vehicleCount }}辆 · 现场：{{ order.acceptedBy }}</p>
        <p class="wo-line muted" v-if="order.delays.length">⏳ 已延期 {{ order.delays.length }} 次，最近 +{{ order.delays[order.delays.length - 1].hours }}h</p>

        <!-- 物资实耗（完工/验收后只读） -->
        <div class="wo-mats" v-if="order.materials.length">
          <span v-for="m in order.materials" :key="m.type" class="wm-chip">
            {{ m.typeLabel }} 耗{{ m.used }}/{{ m.alloc }}{{ m.unit }}
          </span>
        </div>

        <!-- 抢修中：上报进度/完工/延期/失败 -->
        <template v-if="['accepted', 'delayed'].includes(order.status)">
          <button class="wo-act" @click="toggleMode('progress')">📈 上报进度/消耗</button>
          <div v-if="mode === 'progress'" class="wo-form inline">
            <label>进度 {{ progForm.progress }}%</label>
            <input type="range" min="0" max="100" v-model.number="progForm.progress" />
            <div class="mat-row" v-for="(m, i) in order.materials" :key="m.type">
              <span class="mr-name">{{ m.typeLabel }}（已耗 {{ m.used }}/{{ m.alloc }}{{ m.unit }}）</span>
              <input type="number" min="0" :max="m.alloc - m.used" v-model.number="progForm.used[m.type]" placeholder="本次消耗" />
            </div>
            <input v-model="progForm.note" placeholder="进度说明（可空）" />
            <div class="wf-row">
              <button class="ok" @click="onProgress">确认上报</button>
              <button @click="mode = ''">取消</button>
            </div>
          </div>
          <div class="wo-btn2">
            <button class="wo-act fin" @click="onFinish">🏁 完工待验</button>
            <button class="wo-act delay" @click="toggleMode('delay')">⏳ 申请延期</button>
          </div>
          <div v-if="mode === 'delay'" class="wo-form inline">
            <div class="wf-grid">
              <input type="number" min="1" v-model.number="delayForm.hours" placeholder="延期小时" />
              <input v-model="delayForm.reason" placeholder="延期原因（可空）" />
            </div>
            <div class="wf-row">
              <button class="warn" @click="onDelay">确认延期</button>
              <button @click="mode = ''">取消</button>
            </div>
          </div>
          <button class="wo-act fail" @click="toggleMode('fail')">❌ 认定抢修失败</button>
          <div v-if="mode === 'fail'" class="wo-form inline">
            <input v-model="failForm.reason" placeholder="失败原因（可空，阻断将保留）" />
            <div class="wf-row">
              <button class="danger" @click="onFail">确认失败并保留阻断</button>
              <button @click="mode = ''">取消</button>
            </div>
          </div>
          <button class="wo-act cancel" @click="toggleMode('cancel')">🚫 撤单</button>
          <div v-if="mode === 'cancel'" class="wo-form inline">
            <input v-model="cancelForm.reason" placeholder="撤单原因（可空）" />
            <div class="wf-row">
              <button class="danger" @click="onCancel">确认撤单并归还资源</button>
              <button @click="mode = ''">取消</button>
            </div>
          </div>
        </template>

        <!-- 待验收 -->
        <template v-else-if="order.status === 'done'">
          <p class="wo-line await">🏁 {{ order.finishedAt }} 已完工，请验收（阻断仍封闭）</p>
          <button class="wo-act ok2" @click="toggleMode('verify')">✔ 验收通过（解封 + 重算运输）</button>
          <div v-if="mode === 'verify'" class="wo-form inline">
            <input v-model="verifyForm.opinion" placeholder="验收意见（可空）" />
            <div class="wf-row">
              <button class="ok" @click="onVerify(true)">确认通过</button>
              <button @click="mode = ''">取消</button>
            </div>
          </div>
          <button class="wo-act warn2" @click="onVerify(false)">↩️ 验收不通过·退回抢修</button>
        </template>
      </template>

      <!-- 工单日志 -->
      <div class="wo-log">
        <p v-for="(l, i) in order.log.slice(-3)" :key="i"><span>{{ l.at }}</span>{{ l.text }}</p>
      </div>
      <p v-if="msg" class="wo-msg" :class="msgOk ? 'ok' : 'err'">{{ msg }}</p>
    </template>

    <!-- 历史终态工单（失败/撤单，阻断仍生效） -->
    <div v-for="h in history" :key="h.id" class="wo-hist">
      <span :style="{ color: stMetaOf(h.status).color }">●</span>
      工单 {{ h.id.slice(-4) }} {{ stMetaOf(h.status).label }}
      <em>{{ h.endedAt }}</em>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { useCommandStore } from '@/store/command'
import { useRepairStore, REPAIR_MATERIAL_TYPES } from '@/store/repair'
import { RESOURCE_TYPES } from '@/mock/data'

const props = defineProps({ blockId: { type: String, required: true } })

const cmd = useCommandStore()
const repair = useRepairStore()

const materialOptions = REPAIR_MATERIAL_TYPES
const resMeta = (t) => RESOURCE_TYPES[t]

const order = computed(() => repair.orderByBlock[props.blockId] || null)
// 当前阻断下保留阻断的终态工单（失败/撤单）
const history = computed(() =>
  repair.orders.filter((o) => o.blockId === props.blockId && ['failed', 'cancelled'].includes(o.status))
)
const stMeta = computed(() => repair.statusMeta(order.value?.status))
const stMetaOf = (s) => repair.statusMeta(s)

const msg = ref('')
const msgOk = ref(false)
const flash = (r) => { msg.value = r.msg || ''; msgOk.value = !!r.ok }
const clearMsg = () => { msg.value = '' }

/* ---------- 发起 ---------- */
const showCreate = ref(false)
const createForm = reactive({ description: '' })
function onCreate() {
  const r = repair.createOrder(props.blockId, { description: createForm.description })
  flash(r)
  if (r.ok) { showCreate.value = false; createForm.description = '' }
}

/* ---------- 分配 ---------- */
const emptyAssign = () => ({
  baseId: cmd.bases[0]?.id || '',
  teamSize: 12,
  vehicleCount: 2,
  materials: [{ type: 'food', qty: 50 }]
})
const assignForm = reactive(emptyAssign())
const baseStock = (t) => cmd.bases.find((b) => b.id === assignForm.baseId)?.stock[t] || 0
function addMatRow() {
  const t = materialOptions.find((x) => !assignForm.materials.some((m) => m.type === x))
  if (t) assignForm.materials.push({ type: t, qty: 20 })
}
function onAssign() {
  const r = repair.assignOrder(order.value.id, {
    baseId: assignForm.baseId,
    teamSize: assignForm.teamSize,
    vehicleCount: assignForm.vehicleCount,
    materials: assignForm.materials
  })
  flash(r)
}

/* ---------- 接单 ---------- */
const acceptName = ref('')
function onAccept() {
  const r = repair.acceptOrder(order.value.id, { acceptedBy: acceptName.value })
  flash(r)
  if (r.ok) acceptName.value = ''
}

/* ---------- 进度上报 ---------- */
const mode = ref('')
const toggleMode = (m) => { mode.value = mode.value === m ? '' : m; clearMsg() }
const progForm = reactive({ progress: 25, note: '', used: {} })
watch(order, (o) => {
  mode.value = ''
  clearMsg()
  if (o) progForm.progress = Math.max(o.progress || 0, 10)
}, { immediate: true })
function onProgress() {
  const used = {}
  Object.entries(progForm.used).forEach(([t, q]) => { if (q > 0) used[t] = q })
  const r = repair.reportProgress(order.value.id, { progress: progForm.progress, note: progForm.note, used })
  flash(r)
  if (r.ok) { mode.value = ''; progForm.note = ''; progForm.used = {} }
}
function onFinish() {
  const r = repair.finishOrder(order.value.id)
  flash(r)
}

/* ---------- 延期 ---------- */
const delayForm = reactive({ hours: 6, reason: '' })
function onDelay() {
  const r = repair.delayOrder(order.value.id, { hours: delayForm.hours, reason: delayForm.reason })
  flash(r)
  if (r.ok) { mode.value = ''; delayForm.reason = '' }
}

/* ---------- 失败 / 撤单 ---------- */
const failForm = reactive({ reason: '' })
const cancelForm = reactive({ reason: '' })
function onFail() {
  const r = repair.failOrder(order.value.id, { reason: failForm.reason })
  flash(r)
  if (r.ok) { mode.value = ''; failForm.reason = '' }
}
function onCancel() {
  const r = repair.cancelOrder(order.value.id, { reason: cancelForm.reason })
  flash(r)
  if (r.ok) { mode.value = ''; cancelForm.reason = '' }
}

/* ---------- 验收 ---------- */
const verifyForm = reactive({ opinion: '' })
function onVerify(pass) {
  const r = repair.verifyOrder(order.value.id, { pass, opinion: verifyForm.opinion })
  flash(r)
  if (r.ok) { mode.value = ''; verifyForm.opinion = '' }
}
</script>

<style scoped>
.wo {
  margin-top: 8px; border-top: 1px dashed rgba(255,152,0,0.3); padding-top: 8px;
  display: flex; flex-direction: column; gap: 6px;
}
.wo-launch {
  width: 100%; padding: 7px; border: 1px dashed rgba(255,152,0,0.5); border-radius: 7px;
  background: rgba(255,152,0,0.08); color: #ffcc80; font-size: 11px; font-weight: 600; cursor: pointer;
}
.wo-launch:hover { background: rgba(255,152,0,0.16); }
.wo-head { display: flex; align-items: center; gap: 6px; }
.wo-badge { color: #fff; font-size: 10px; padding: 2px 7px; border-radius: 4px; }
.wo-head strong { font-size: 11px; color: #fff; }
.wo-id { margin-left: auto; font-size: 9px; color: #5b6f94; font-family: monospace; }
.wo-line { font-size: 10px; color: #dbe4f3; margin: 0; }
.wo-line.muted { color: #5b6f94; }
.wo-line.await { color: #ce93ff; }

.wo-form { display: flex; flex-direction: column; gap: 5px; }
.wo-form.inline {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 7px; padding: 7px; margin-top: 2px;
}
.create-box {
  background: #0c1730; border: 1px solid rgba(255,152,0,0.3);
  border-radius: 7px; padding: 8px;
}
.wo-form label { font-size: 10px; color: #8ba2c8; }
.wo-form label em { font-style: normal; color: #7ef0c9; margin-left: 6px; }
.wo-form select, .wo-form input, .wo-form textarea {
  width: 100%; background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 5px 7px; font-size: 11px; box-sizing: border-box;
}
.wf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.wf-row { display: flex; gap: 6px; }
.wf-row button {
  flex: 1; padding: 5px 0; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 11px; border-radius: 6px; cursor: pointer;
}
.wf-row button.ok { border-color: rgba(76,175,80,0.5); color: #a5d6a7; }
.wf-row button.ok:hover { background: rgba(76,175,80,0.15); }
.wf-row button.warn { border-color: rgba(255,152,0,0.5); color: #ffcc80; }
.wf-row button.warn:hover { background: rgba(255,152,0,0.12); }
.wf-row button.danger { border-color: rgba(239,83,80,0.55); color: #ef9a9a; }
.wf-row button.danger:hover { background: rgba(239,83,80,0.12); }

.mat-row { display: flex; gap: 5px; align-items: center; }
.mat-row select, .mat-row input { flex: 1; min-width: 0; }
.mat-del {
  background: none; border: none; color: #5b6f94; cursor: pointer; font-size: 11px; padding: 0 2px;
}
.mat-add {
  align-self: flex-start; background: none; border: 1px dashed rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 8px; cursor: pointer;
}
.mr-name { flex: 1; font-size: 10px; color: #8ba2c8; }

.wo-prog { display: flex; align-items: center; gap: 7px; }
.wp-bar { flex: 1; height: 6px; background: #0c1730; border-radius: 3px; overflow: hidden; }
.wp-bar i { display: block; height: 100%; border-radius: 3px; transition: width 0.3s; }
.wo-prog span { font-size: 10px; color: #ffc107; font-weight: 700; }
.wo-mats { display: flex; flex-wrap: wrap; gap: 4px; }
.wm-chip {
  font-size: 9px; background: #0c1730; border: 1px solid rgba(255,152,0,0.25);
  color: #ffcc80; padding: 1px 6px; border-radius: 4px;
}

.wo-act {
  width: 100%; padding: 5px; background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 6px; cursor: pointer;
}
.wo-act:hover { color: #fff; border-color: #4d8dff; }
.wo-btn2 { display: flex; gap: 6px; }
.wo-btn2 .wo-act { flex: 1; }
.wo-act.fin { border-color: rgba(171,71,188,0.5); color: #ce93ff; }
.wo-act.delay { border-color: rgba(255,112,67,0.5); color: #ffab91; }
.wo-act.fail { border-color: rgba(239,83,80,0.4); color: #ef9a9a; }
.wo-act.cancel { border-color: rgba(91,111,148,0.5); color: #8ba2c8; }
.wo-act.ok2 { border-color: rgba(76,175,80,0.55); color: #a5d6a7; background: rgba(76,175,80,0.08); }
.wo-act.warn2 { border-color: rgba(255,152,0,0.4); color: #ffcc80; }

.wo-log { border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.wo-log p { font-size: 9px; color: #5b6f94; margin: 2px 0; display: flex; gap: 6px; }
.wo-log span { color: #ff9800; font-family: monospace; flex-shrink: 0; }
.wo-msg { font-size: 10px; margin: 0; }
.wo-msg.ok { color: #a5d6a7; }
.wo-msg.err { color: #ef9a9a; }
.wo-hist {
  display: flex; align-items: center; gap: 6px; font-size: 10px; color: #8ba2c8;
  background: rgba(12,23,48,0.6); border-radius: 6px; padding: 4px 8px;
}
.wo-hist em { margin-left: auto; font-style: normal; color: #5b6f94; font-size: 9px; }
</style>
