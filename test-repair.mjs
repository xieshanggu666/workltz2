import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const repair = useRepairStore()
cmd.loadScenario('s1')
tr.load()
rb.load()
repair.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

// 江油事件 ev-001 与绵阳库 rb-2 之间的阻断走廊
const ev = cmd.events.find((e) => e.id === 'ev-001')
const midPoly = [
  [104.6438, 31.5209], [104.8438, 31.5209],
  [104.8438, 31.7209], [104.6438, 31.7209]
]
const rb1 = () => cmd.bases.find((b) => b.id === 'rb-1')
const rb2 = () => cmd.bases.find((b) => b.id === 'rb-2')
const rb4 = () => cmd.bases.find((b) => b.id === 'rb-4')

console.log('— 发起抢修工单：阻断校验 / 防重复 —')
assert(!repair.createOrder('blk-nope').ok, '不存在的阻断不能发起工单')
const rep = rb.reportBlock({ name: '绵江公路塌方断道', polygon: midPoly })
const blk = rep.block
const wo0 = repair.createOrder(blk.id)
assert(wo0.ok, '生效阻断可发起抢修工单')
const wo = repair.orderByBlock[blk.id]
assert(wo && wo.status === 'created', '工单初始为「待分配」')
const dup = repair.createOrder(blk.id)
assert(!dup.ok, '同一阻断的进行中工单不可重复发起')
assert(!repair.acceptOrder(wo.id).ok, '未分配不能接单')
assert(!repair.reportProgress(wo.id, { progress: 10 }).ok, '未接单不能上报进度')

console.log('— 指挥员分配：库存校验 / 占用 / 重分配 —')
const p0 = rb1().stock.personnel, v0 = rb1().stock.vehicle, f0 = rb1().stock.food, w0 = rb1().stock.water
assert(!repair.assignOrder(wo.id, { baseId: 'rb-1', teamSize: 0, vehicleCount: 1 }).ok, '队伍为 0 被拒绝')
assert(!repair.assignOrder(wo.id, { baseId: 'rb-2', teamSize: 5, vehicleCount: 1 }).ok, '绵阳库无救援人员，分配被拒绝')
const bad = repair.assignOrder(wo.id, {
  baseId: 'rb-1', teamSize: 10, vehicleCount: 2,
  materials: [{ type: 'food', qty: 999999 }]
})
assert(!bad.ok && rb1().stock.food === f0, '物资库存不足被拒绝且不产生扣减')
const asr = repair.assignOrder(wo.id, {
  baseId: 'rb-1', teamSize: 20, vehicleCount: 3,
  materials: [{ type: 'food', qty: 100 }, { type: 'water', qty: 50 }, { type: 'food', qty: 5 }, { type: 'medical', qty: 0 }]
})
assert(asr.ok, '分配成功（重复物资行去重、0 数量忽略）')
assert(wo.status === 'assigned' && wo.materials.length === 2, '工单进入「待接单」，物资两行')
assert(rb1().stock.personnel === p0 - 20 && rb1().stock.vehicle === v0 - 3, '人员/车辆库存占用')
assert(rb1().stock.food === f0 - 100 && rb1().stock.water === w0 - 50, '物资库存占用')
// 重新分配：旧占用释放、新基地扣减
const fr0 = rb4().stock.food
repair.assignOrder(wo.id, {
  baseId: 'rb-4', teamSize: 8, vehicleCount: 2,
  materials: [{ type: 'food', qty: 30 }]
})
assert(wo.baseId === 'rb-4', '可改派至其它基地重新分配')
assert(rb1().stock.personnel === p0 && rb1().stock.vehicle === v0 && rb1().stock.food === f0 && rb1().stock.water === w0,
  '重分配后旧基地占用全部归还')
assert(rb4().stock.personnel === 150 - 8 && rb4().stock.vehicle === 60 - 2 && rb4().stock.food === fr0 - 30,
  '新基地按新方案扣减')
// 分配回 rb-1 继续主流程（含多物资实耗结算）
repair.assignOrder(wo.id, {
  baseId: 'rb-1', teamSize: 20, vehicleCount: 3,
  materials: [{ type: 'food', qty: 100 }, { type: 'water', qty: 50 }]
})

console.log('— 现场接单 → 进度上报（实耗累计校验）→ 延期保留阻断 —')
// 先把受阻断影响的派发挂起，验证验收通过后续派
const rec = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'food', qty: 100 })
rb.assess(blk.id)
rb.confirmImpacts(blk.id)
const imp = blk.impacts.find((i) => i.id === rec.id)
imp.plan = imp.options.find((o) => o.action === 'suspend')
rb.applyImpact(blk.id, imp.key)
assert(rec.status === 'held' && blk.status === 'active', '前置：受影响派发已挂起、阻断生效中')

assert(repair.acceptOrder(wo.id, { acceptedBy: '抢险一班' }).ok, '现场接单')
assert(wo.status === 'accepted', '工单进入「抢修中」')
assert(!repair.reportProgress(wo.id, { progress: 40, used: { food: 130 } }).ok, '单次实耗超分配量被拦截')
assert(repair.reportProgress(wo.id, { progress: 40, used: { food: 30 }, note: '清理塌方体' }).ok, '上报 40% + 食品实耗 30')
assert(repair.delayOrder(wo.id, { hours: 6, reason: '降雨持续' }).ok, '申请延期 6 小时')
assert(wo.status === 'delayed' && blk.status === 'active', '延期后阻断继续封闭')
assert(repair.reportProgress(wo.id, { progress: 80, used: { food: 40, water: 50 } }).ok, '延期后继续上报（累计食品 70、饮用水 50）')
assert(!repair.reportProgress(wo.id, { progress: 90, used: { water: 1 } }).ok, '累计实耗超分配量被拦截')
assert(rec.status === 'held', '抢修未验收前挂起任务不续派')

console.log('— 完工 → 验收不通过退回 → 验收通过：解封 + 重算运输 + 资源结算 —')
assert(repair.finishOrder(wo.id).ok, '现场完工待验')
assert(wo.status === 'done' && wo.progress === 100 && blk.status === 'active', '待验收期间阻断仍封闭')
assert(!repair.cancelOrder(wo.id).ok, '完工待验收不能撤单（须走验收）')
assert(repair.verifyOrder(wo.id, { pass: false, opinion: '边缘仍有裂缝' }).ok, '验收不通过退回抢修')
assert(wo.status === 'accepted' && blk.status === 'active', '退回后阻断保持封闭')
repair.finishOrder(wo.id)
const stockBeforeVerify = {
  p: rb1().stock.personnel, v: rb1().stock.vehicle, f: rb1().stock.food, w: rb1().stock.water
}
const vr = repair.verifyOrder(wo.id, { pass: true })
assert(vr.ok && wo.status === 'verified', '验收通过')
assert(blk.status === 'cleared', '阻断自动解除封闭')
assert(rec.status === 'enroute', '受影响运输自动续派（重算受影响运输）')
assert(rb1().stock.personnel === p0 && rb1().stock.vehicle === v0, '人员/车辆到期全部归队')
assert(rb1().stock.food === f0 - 70, `食品按实耗结算（耗 70 退 30，库存 ${rb1().stock.food}）`)
assert(rb1().stock.water === w0 - 50, '饮用水全部消耗无退回')
assert(wo.returnLog && wo.returnLog.materials.find((m) => m.type === 'food').returned === 30, '归还快照留痕')
assert(!repair.verifyOrder(wo.id).ok, '终态工单不可重复验收')

console.log('— 抢修失败：按实际消耗归还、阻断保留、可重新发起 —')
const rec2 = cmd.dispatchResource({ baseId: 'rb-2', eventId: ev.id, type: 'water', qty: 60 })
const blk2 = rb.reportBlock({ name: '阻断2', polygon: midPoly }).block
rb.confirmImpacts(blk2.id)
const imp2 = blk2.impacts.find((i) => i.id === rec2.id)
imp2.plan = imp2.options.find((o) => o.action === 'detour')
rb.applyImpact(blk2.id, imp2.key)
assert(rec2.via.length > 0, '前置：第二条派发绕行中')
const m0 = rb1().stock.medical
const wo2 = repair.createOrder(blk2.id).order
repair.assignOrder(wo2.id, {
  baseId: 'rb-1', teamSize: 15, vehicleCount: 2,
  materials: [{ type: 'medical', qty: 20 }]
})
repair.acceptOrder(wo2.id)
repair.reportProgress(wo2.id, { progress: 50, used: { medical: 8 } })
const fr = repair.failOrder(wo2.id, { reason: '二次塌方' })
assert(fr.ok && wo2.status === 'failed', '认定抢修失败')
assert(blk2.status === 'active' && rec2.via.length > 0, '失败后阻断保留、绕行运输维持')
assert(rb1().stock.medical === m0 - 8, '失败按实际消耗归还（耗 8 退 12）')
assert(rb1().stock.personnel === p0 && rb1().stock.vehicle === v0, '失败后人员车辆归队')
assert(!!repair.createOrder(blk2.id).ok, '失败后允许就同一阻断重新发起工单')

console.log('— 重新发起的工单验收通过：阻断解封、绕行回直 —')
const wo2b = repair.orderByBlock[blk2.id]
repair.assignOrder(wo2b.id, { baseId: 'rb-1', teamSize: 10, vehicleCount: 1, materials: [] })
repair.acceptOrder(wo2b.id)
repair.finishOrder(wo2b.id)
repair.verifyOrder(wo2b.id, { pass: true })
assert(blk2.status === 'cleared' && rec2.via.length === 0, '重新抢修验收后解封，绕行路线联合重算回直')
assert(rb1().stock.personnel === p0 && rb1().stock.vehicle === v0, '无物资消耗时人员车辆全额归还')

console.log('— 撤单：按实际消耗归还（未开工即全退）、阻断保留 —')
const blk3 = rb.reportBlock({ name: '阻断3', polygon: midPoly }).block
const wo3 = repair.createOrder(blk3.id).order
assert(repair.cancelOrder(wo3.id).ok, '待分配工单可直接撤单')
assert(wo3.status === 'cancelled' && blk3.status === 'active', '撤单后阻断保留')
const wo4 = repair.createOrder(blk3.id).order
const fa0 = rb1().stock.food
repair.assignOrder(wo4.id, {
  baseId: 'rb-1', teamSize: 12, vehicleCount: 2,
  materials: [{ type: 'food', qty: 40 }]
})
assert(!repair.cancelOrder('nope').ok, '撤不存在的单报错')
const cr = repair.cancelOrder(wo4.id, { reason: '调往它处' })
assert(cr.ok && wo4.status === 'cancelled', '待接单工单可撤单')
assert(rb1().stock.food === fa0 && rb1().stock.personnel === p0 && rb1().stock.vehicle === v0,
  '未开工撤单：物资/人员/车辆全部归还')
assert(blk3.status === 'active', '撤单不解除阻断')
assert(!!repair.createOrder(blk3.id).ok, '撤单后可重新发起')

console.log('— 抢修中撤单：已耗物资不重复退还 —')
const wo5 = repair.orderByBlock[blk3.id]
repair.assignOrder(wo5.id, {
  baseId: 'rb-1', teamSize: 10, vehicleCount: 1,
  materials: [{ type: 'food', qty: 30 }]
})
repair.acceptOrder(wo5.id)
repair.reportProgress(wo5.id, { progress: 30, used: { food: 12 } })
repair.cancelOrder(wo5.id, { reason: '任务调整' })
assert(rb1().stock.food === fa0 - 12, '抢修中撤单仅退还未消耗部分（耗 12 退 18）')
assert(rb1().stock.personnel === p0 && rb1().stock.vehicle === v0, '撤单后人员车辆归队')
assert(blk3.status === 'active', '抢修中撤单同样保留阻断')

console.log('— 大屏统计与终态守卫 —')
assert(repair.activeCount === 0, '全部工单终结，进行中计数归零')
assert(!repair.finishOrder(wo.id).ok, '已验收工单不能再完工')
assert(!repair.acceptOrder(wo2.id).ok, '已失败工单不能接单')
assert(!repair.delayOrder(wo3.id).ok, '已撤单工单不能延期')

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
