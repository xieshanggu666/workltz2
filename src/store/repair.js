import { defineStore } from 'pinia'
import { RESOURCE_TYPES } from '@/mock/data'
import { useCommandStore, pathMetrics } from '@/store/command'
import { useRoadblockStore } from '@/store/roadblock'

let woSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 工单状态机：
//   created    已发起，待指挥员分配
//   assigned   已分配队伍/车辆/物资，待现场接单
//   accepted   现场已接单，抢修中（可上报进度、申请延期）
//   delayed    延期抢修中（保留阻断，仍可继续上报进度直至完工/失败）
//   done       现场完工，待验收
//   verified   验收通过（终态：解除封闭、重算受影响运输）
//   failed     抢修失败（终态：保留阻断，可重新发起新工单）
//   cancelled  已撤单（终态）
export const REPAIR_STATUS = [
  { value: 'created', label: '待分配', color: '#9e9e9e' },
  { value: 'assigned', label: '待接单', color: '#4d8dff' },
  { value: 'accepted', label: '抢修中', color: '#ff9800' },
  { value: 'delayed', label: '已延期', color: '#ff7043' },
  { value: 'done', label: '待验收', color: '#ab47bc' },
  { value: 'verified', label: '验收通过', color: '#4caf50' },
  { value: 'failed', label: '抢修失败', color: '#ef5350' },
  { value: 'cancelled', label: '已撤单', color: '#5b6f94' }
]

// 可分配为抢修物资的类型（人员与车辆单独分配，不作为物资行）
export const REPAIR_MATERIAL_TYPES = ['medical', 'food', 'water', 'tent']

// 进行中（未终结、阻断仍生效）的状态
const ACTIVE_STATUS = ['created', 'assigned', 'accepted', 'delayed', 'done']

// 道路抢修工单：阻断记录发起 → 指挥员分配队伍/车辆/物资 → 现场接单上报进度
// → 完工验收：通过则解除封闭并重算受影响运输；延期/失败保留阻断；撤单/完工按实际消耗归还资源
export const useRepairStore = defineStore('repair', {
  state: () => ({
    orders: []
  }),

  getters: {
    statusMeta: () => (s) => REPAIR_STATUS.find((x) => x.value === s) || { label: s, color: '#999' },
    activeOrders(state) { return state.orders.filter((o) => ACTIVE_STATUS.includes(o.status)) },
    activeCount() { return this.activeOrders.length },
    inProgressCount(state) {
      return state.orders.filter((o) => ['accepted', 'delayed'].includes(o.status)).length
    },
    // 阻断 id -> 当前生效工单（进行中最多一单）
    orderByBlock(state) {
      const m = {}
      state.orders.forEach((o) => { if (ACTIVE_STATUS.includes(o.status)) m[o.blockId] = o })
      return m
    }
  },

  actions: {
    _cmd() { return useCommandStore() },
    _rb() { return useRoadblockStore() },
    _order(id) { return this.orders.find((o) => o.id === id) },
    _log(wo, text) { wo.log.push({ at: nowStr(), text }) },

    load() { this.orders = [] },

    // 阻断记录发起抢修工单（仅生效阻断、且无进行中工单时可发起）
    createOrder(blockId, { description = '' } = {}) {
      const rb = this._rb()
      const blk = rb.blocks.find((b) => b.id === blockId)
      if (!blk) return { ok: false, msg: '阻断记录不存在' }
      if (blk.status !== 'active') return { ok: false, msg: '阻断已恢复通行，无需抢修' }
      if (this.orderByBlock[blockId]) return { ok: false, msg: '该阻断已有进行中的抢修工单' }
      const cx = blk.polygon.reduce((s, p) => s + p[0], 0) / blk.polygon.length
      const cy = blk.polygon.reduce((s, p) => s + p[1], 0) / blk.polygon.length
      const wo = {
        id: 'wo-' + Date.now() + '-' + ++woSeq,
        blockId,
        blockName: blk.name,
        lng: +cx.toFixed(6), lat: +cy.toFixed(6),
        description: (description || '').trim(),
        status: 'created',
        createdAt: nowStr(),
        // 指挥员分配
        baseId: null, baseName: null,
        teamSize: 0, vehicleCount: 0,
        materials: [],          // [{ type, typeLabel, unit, alloc 分配量, used 实耗量 }]
        assignedAt: null,
        // 现场处置
        acceptedAt: null, progress: 0,
        finishedAt: null, acceptedBy: '',
        // 验收/终结
        verifiedAt: null, endedAt: null,
        delays: [],             // 延期申请 [{ at, hours, reason }]
        progressLogs: [],       // 进度上报 [{ at, progress, note, used: {type:qty} }]
        returnLog: null,        // 资源归还快照 { vehicles, personnel, materials: [{type,used,ret}] }
        log: []
      }
      this.orders.unshift(wo)
      this._log(wo, `📋 阻断「${blk.name}」发起道路抢修工单，等待指挥员分配队伍`)
      return { ok: true, order: wo }
    },

    // 抢修 ETA：基地 → 阻断质心车程 + 固定作业时长（演示用）
    _eta(baseId, wo) {
      const cmd = this._cmd()
      const base = cmd.bases.find((b) => b.id === baseId)
      if (!base) return null
      const m = pathMetrics([[base.lng, base.lat], [wo.lng, wo.lat]])
      return { distance: m.distance, minutes: m.minutes + 120 }
    },

    // 指挥员分配：队伍（人员）、车辆、物资，统一校验后一次性占用基地库存（预占即出库）
    assignOrder(orderId, { baseId, teamSize, vehicleCount, materials = [] } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (!['created', 'assigned'].includes(wo.status)) return { ok: false, msg: '当前状态不能分配' }
      const cmd = this._cmd()
      const base = cmd.bases.find((b) => b.id === baseId)
      teamSize = Math.max(0, Math.round(teamSize || 0))
      vehicleCount = Math.max(0, Math.round(vehicleCount || 0))
      if (!base) return { ok: false, msg: '请选择队伍/车辆/物资来源基地' }
      if (teamSize <= 0) return { ok: false, msg: '抢修队伍至少 1 人' }
      if (vehicleCount <= 0) return { ok: false, msg: '抢修车辆至少 1 辆' }

      // 物资行规整：合法类型、去重、正数
      const mats = []
      const seen = new Set()
      for (const m of materials) {
        const qty = Math.max(0, Math.round(m.qty || m.alloc || 0))
        if (qty <= 0) continue
        if (!REPAIR_MATERIAL_TYPES.includes(m.type) || seen.has(m.type)) continue
        seen.add(m.type)
        mats.push({ type: m.type, alloc: qty })
      }

      // 重新分配时把旧占用先释放，再按新方案校验扣减
      const revert = wo.status === 'assigned' ? this._releaseResources(wo, true) : null
      const shortage = []
      if (teamSize > (base.stock.personnel || 0)) shortage.push(`${RESOURCE_TYPES.personnel.label}（需 ${teamSize}，余 ${base.stock.personnel || 0}）`)
      if (vehicleCount > (base.stock.vehicle || 0)) shortage.push(`${RESOURCE_TYPES.vehicle.label}（需 ${vehicleCount}，余 ${base.stock.vehicle || 0}）`)
      mats.forEach((m) => {
        if (m.alloc > (base.stock[m.type] || 0)) {
          shortage.push(`${RESOURCE_TYPES[m.type].label}（需 ${m.alloc}，余 ${base.stock[m.type] || 0}）`)
        }
      })
      if (shortage.length) {
        if (revert) this._reapplyReleased(wo, revert) // 新方案校验失败：恢复旧占用
        return { ok: false, msg: `${base.name} 库存不足：${shortage.join('、')}` }
      }

      base.stock.personnel = (base.stock.personnel || 0) - teamSize
      base.stock.vehicle = (base.stock.vehicle || 0) - vehicleCount
      mats.forEach((m) => { base.stock[m.type] = (base.stock[m.type] || 0) - m.alloc })

      wo.baseId = base.id
      wo.baseName = base.name
      wo.teamSize = teamSize
      wo.vehicleCount = vehicleCount
      wo.materials = mats.map((m) => ({
        type: m.type,
        typeLabel: RESOURCE_TYPES[m.type].label,
        unit: RESOURCE_TYPES[m.type].unit,
        alloc: m.alloc,
        used: 0
      }))
      wo.assignedAt = nowStr()
      wo.eta = this._eta(baseId, wo)
      wo.status = 'assigned'
      wo.returnLog = null // 重新分配成功：旧归还快照作废，终结时按新占用重新结算
      const matTxt = wo.materials.length ? `，物资 ${wo.materials.map((m) => `${m.typeLabel}${m.alloc}${m.unit}`).join('、')}` : ''
      this._log(wo, `🧰 指挥员分配：${base.name} 出动抢修队 ${teamSize} 人、车辆 ${vehicleCount} 辆${matTxt}，等待现场接单`)
      return { ok: true, order: wo }
    },

    // 现场接单
    acceptOrder(orderId, { acceptedBy = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (wo.status !== 'assigned') return { ok: false, msg: '工单未分配或已接单' }
      wo.status = 'accepted'
      wo.acceptedAt = nowStr()
      wo.acceptedBy = (acceptedBy || '').trim() || '现场抢修队'
      this._log(wo, `🛻 现场接单：${wo.acceptedBy} 已率队抵达开展抢修（预计 ${wo.eta?.minutes || '—'}min）`)
      return { ok: true, order: wo }
    },

    // 现场上报进度（0~100），可同批登记物资实际消耗（累计不超过分配量）
    reportProgress(orderId, { progress, note = '', used = {} } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (!['accepted', 'delayed'].includes(wo.status)) return { ok: false, msg: '仅抢修中工单可上报进度' }
      progress = Math.max(0, Math.min(100, Math.round(progress || 0)))
      // 消耗校验：逐类型累计实耗不超过分配量
      const add = {}
      for (const m of wo.materials) {
        const qty = Math.max(0, Math.round(used[m.type] || 0))
        if (!qty) continue
        if (m.used + qty > m.alloc) {
          return { ok: false, msg: `${m.typeLabel}本次消耗 ${qty}${m.unit} 超出剩余可耗 ${m.alloc - m.used}${m.unit}` }
        }
        add[m.type] = qty
      }
      Object.entries(add).forEach(([type, qty]) => {
        const m = wo.materials.find((x) => x.type === type)
        m.used += qty
      })
      wo.progress = Math.max(wo.progress, progress)
      wo.progressLogs.push({
        at: nowStr(), progress: wo.progress, note: (note || '').trim(),
        used: { ...add }
      })
      const usedTxt = Object.keys(add).length
        ? `，实耗 ${Object.entries(add).map(([t, q]) => `${RESOURCE_TYPES[t].label}${q}${RESOURCE_TYPES[t].unit}`).join('、')}`
        : ''
      this._log(wo, `📈 进度上报：${wo.progress}%${usedTxt}${note ? `（${note}）` : ''}`)
      return { ok: true, order: wo }
    },

    // 现场完工（待验收）
    finishOrder(orderId, { note = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (!['accepted', 'delayed'].includes(wo.status)) return { ok: false, msg: '仅抢修中工单可申报完工' }
      wo.status = 'done'
      wo.progress = 100
      wo.finishedAt = nowStr()
      wo.progressLogs.push({ at: wo.finishedAt, progress: 100, note: (note || '').trim() || '现场抢修完工，申请验收', used: {} })
      this._log(wo, `🏁 现场申报完工，等待指挥员验收（阻断仍保持封闭）`)
      return { ok: true, order: wo }
    },

    // 申请延期：保留阻断、继续抢修
    delayOrder(orderId, { hours = 0, reason = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (!['accepted', 'delayed'].includes(wo.status)) return { ok: false, msg: '仅抢修中工单可申请延期' }
      hours = Math.max(0, Math.round(hours || 0))
      if (hours <= 0) return { ok: false, msg: '请填写延期时长（小时）' }
      wo.status = 'delayed'
      wo.delays.push({ at: nowStr(), hours, reason: (reason || '').trim() || '现场情况复杂' })
      this._log(wo, `⏳ 申请延期 ${hours} 小时（${wo.delays[wo.delays.length - 1].reason}），阻断继续封闭、运输维持绕行/挂起`)
      return { ok: true, order: wo }
    },

    // 抢修失败：终结工单、保留阻断（按实际消耗归还资源，可重新发起新工单）
    failOrder(orderId, { reason = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (!['accepted', 'delayed'].includes(wo.status)) return { ok: false, msg: '仅抢修中工单可认定失败' }
      const ret = this._releaseResources(wo)
      wo.status = 'failed'
      wo.endedAt = nowStr()
      wo.failReason = (reason || '').trim() || '抢通失败，阻断仍在'
      this._log(wo, `❌ 抢修失败：${wo.failReason}。按实际消耗归还资源，阻断保留，可重新发起抢修工单`)
      return { ok: true, order: wo, returned: ret }
    },

    // 撤单：仅未接单/抢修中可撤；完工待验收请走验收（完工按实际消耗归还）
    cancelOrder(orderId, { reason = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (['created', 'assigned', 'accepted', 'delayed'].includes(wo.status) === false) {
        return { ok: false, msg: '工单已终结或待验收，不能撤单' }
      }
      const ret = this._releaseResources(wo)
      wo.status = 'cancelled'
      wo.endedAt = nowStr()
      wo.cancelReason = (reason || '').trim() || '指挥员撤单'
      this._log(wo, `🚫 工单撤销（${wo.cancelReason}），已按实际消耗归还资源，阻断保持封闭`)
      return { ok: true, order: wo, returned: ret }
    },

    // 验收：通过 → 按实际消耗归还资源 + 解除封闭 + 重算受影响运输；不通过 → 退回抢修中
    verifyOrder(orderId, { pass = true, opinion = '' } = {}) {
      const wo = this._order(orderId)
      if (!wo) return { ok: false, msg: '工单不存在' }
      if (wo.status !== 'done') return { ok: false, msg: '仅完工待验收工单可验收' }
      if (!pass) {
        wo.status = 'accepted'
        this._log(wo, `↩️ 验收不通过（${(opinion || '').trim() || '需返工'}），退回现场继续抢修，阻断保持封闭`)
        return { ok: true, order: wo }
      }
      const ret = this._releaseResources(wo)
      wo.status = 'verified'
      wo.verifiedAt = nowStr()
      wo.verifyOpinion = (opinion || '').trim() || '验收合格'
      this._log(wo, `✅ 验收通过：${wo.verifyOpinion}。车辆/人员归还、物资按实际消耗结算，解除封闭并重算受影响运输`)

      // 解除封闭：roadblock.clearBlock 已完成绕行路线联合重排；再续派全部挂起任务并跨阻断复核
      const rb = this._rb()
      const blk = rb.blocks.find((b) => b.id === wo.blockId)
      if (blk && blk.status === 'active') {
        rb.clearBlock(blk.id)
        const r = rb.resumeHeld()
        if (r.resumed) this._log(wo, `▶️ 解除封闭后续派 ${r.resumed} 项受影响运输` + (r.kept ? `，${r.kept} 项仍受其它阻断影响保持挂起` : ''))
        rb.assessActive() // 剩余生效阻断视角重新评估在途任务
      }
      return { ok: true, order: wo, returned: ret }
    },

    /* ---------- 资源按实际消耗归还 ----------
     * 分配时预占即出库：人员/车辆到期全部归队；物资 = 分配量 - 实耗量 回库。
     * 撤单（created 无占用 / assigned 未开工实耗为 0）即全部归还。 */
    _releaseResources(wo, silent = false) {
      if (wo.returnLog) return wo.returnLog
      const cmd = this._cmd()
      const base = cmd.bases.find((b) => b.id === wo.baseId)
      const mats = []
      wo.materials.forEach((m) => {
        const retQty = Math.max(0, m.alloc - (m.used || 0))
        if (base && retQty > 0) base.stock[m.type] = (base.stock[m.type] || 0) + retQty
        mats.push({ type: m.type, typeLabel: m.typeLabel, unit: m.unit, alloc: m.alloc, used: m.used || 0, returned: retQty })
      })
      if (base) {
        base.stock.personnel = (base.stock.personnel || 0) + wo.teamSize
        base.stock.vehicle = (base.stock.vehicle || 0) + wo.vehicleCount
      }
      const ret = { baseId: wo.baseId, baseName: wo.baseName, personnel: wo.teamSize, vehicles: wo.vehicleCount, materials: mats }
      wo.returnLog = ret
      if (!silent) {
        this._log(wo, `🔄 资源归还：人员 ${wo.teamSize} 人、车辆 ${wo.vehicleCount} 辆归队`
          + (mats.length ? `；物资按实耗结算（${mats.map((m) => `${m.typeLabel}耗${m.used}/${m.alloc}${m.unit}退${m.returned}`).join('，')}）` : ''))
      }
      return ret
    },

    // 重新分配校验失败时恢复旧占用（与 _releaseResources(silent) 配对）
    _reapplyReleased(wo, ret) {
      const cmd = this._cmd()
      const base = cmd.bases.find((b) => b.id === ret.baseId)
      if (!base) return
      base.stock.personnel = (base.stock.personnel || 0) - ret.personnel
      base.stock.vehicle = (base.stock.vehicle || 0) - ret.vehicles
      ret.materials.forEach((m) => {
        if (m.returned > 0) base.stock[m.type] = (base.stock[m.type] || 0) - m.returned
      })
      wo.returnLog = null
    }
  }
})
