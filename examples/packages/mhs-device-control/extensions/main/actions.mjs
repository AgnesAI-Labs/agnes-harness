// Action names follow Unitree's public Go2 SportClient where there is a direct equivalent.
// new_year_greeting is an app-level presentation sequence, not a SportClient method.
export const DOG_ACTIONS = Object.freeze(
  [
    {
      id: 'stand',
      label: '站立',
      aliases: ['起立', '站起来'],
      durationMs: 1800,
      stages: ['重心归中', '四足伸展', '站姿稳定', '姿态保持'],
    },
    {
      id: 'lie_down',
      label: '卧倒',
      aliases: ['趴下', '伏地'],
      durationMs: 2000,
      stages: ['降低机身', '调整四足', '接近地面', '卧姿稳定'],
    },
    {
      id: 'sit',
      label: '坐下',
      aliases: ['坐好'],
      durationMs: 1900,
      stages: ['后肢收拢', '机身下降', '前肢支撑', '坐姿稳定'],
    },
    {
      id: 'heart',
      label: '比心',
      aliases: ['爱心'],
      durationMs: 4500,
      stages: ['进入表演姿态', '抬起前肢', '完成比心动作', '回到稳定姿态'],
    },
    {
      id: 'new_year_greeting',
      label: '拜年',
      aliases: ['作揖', '新年快乐'],
      durationMs: 5200,
      stages: ['进入迎宾姿态', '抬起前肢', '完成拜年动作', '恢复站姿'],
    },
    {
      id: 'dance',
      label: '舞蹈',
      aliases: ['跳舞', '跳个舞'],
      durationMs: 6500,
      stages: ['进入舞蹈姿态', '执行第一段节奏', '执行第二段节奏', '收尾并站稳'],
    },
    {
      id: 'stretch',
      label: '伸懒腰',
      aliases: ['拉伸'],
      durationMs: 4400,
      stages: ['降低前躯', '伸展前肢', '保持拉伸', '恢复站姿'],
    },
    {
      id: 'front_pounce',
      label: '前扑',
      aliases: ['扑人', '向前扑'],
      durationMs: 4500,
      stages: ['调整重心', '前肢预载', '完成前扑', '着地稳定'],
    },
    {
      id: 'front_flip',
      label: '前翻',
      aliases: ['前空翻', '向前翻跟斗', '翻跟斗'],
      durationMs: 5500,
      stages: ['进入翻转预备姿态', '起跳', '完成前向翻转', '落地站稳'],
    },
    {
      id: 'back_flip',
      label: '后翻',
      aliases: ['后空翻', '向后翻跟斗'],
      durationMs: 5500,
      stages: ['进入翻转预备姿态', '起跳', '完成后向翻转', '落地站稳'],
    },
    {
      id: 'left_flip',
      label: '侧翻',
      aliases: ['左侧翻'],
      durationMs: 5300,
      stages: ['调整侧向重心', '起跳', '完成侧向翻转', '落地站稳'],
    },
    {
      id: 'front_jump',
      label: '前跳',
      aliases: ['跳跃', '向前跳'],
      durationMs: 4200,
      stages: ['压低重心', '起跳', '前向腾跃', '落地站稳'],
    },
    {
      id: 'hello',
      label: '打招呼',
      aliases: ['挥手', '你好'],
      durationMs: 3600,
      stages: ['进入互动姿态', '抬起前肢', '完成招呼动作', '恢复站姿'],
    },
    {
      id: 'move_forward',
      label: '向前行进',
      aliases: ['前进', '往前走'],
      durationMs: 4200,
      stages: ['进入行进步态', '开始前进', '保持目标速度', '减速停止'],
    },
    {
      id: 'move_backward',
      label: '向后行进',
      aliases: ['后退', '往后走'],
      durationMs: 4200,
      stages: ['进入行进步态', '开始后退', '保持目标速度', '减速停止'],
    },
    {
      id: 'turn_left',
      label: '向左转',
      aliases: ['左转'],
      durationMs: 2800,
      stages: ['锁定转向角度', '开始左转', '调整朝向', '转向结束'],
    },
    {
      id: 'turn_right',
      label: '向右转',
      aliases: ['右转'],
      durationMs: 2800,
      stages: ['锁定转向角度', '开始右转', '调整朝向', '转向结束'],
    },
    {
      id: 'stop',
      label: '停止',
      aliases: ['停下', '急停'],
      durationMs: 1000,
      stages: ['接收停止请求', '降低运动速度', '保持四足支撑', '进入待命'],
    },
  ].map(Object.freeze),
)

export const CAR_ACTIONS = Object.freeze(
  [
    {
      id: 'drive_forward',
      label: '向前行驶',
      aliases: ['前进', '往前开'],
      durationMs: 4200,
      stages: ['检查行驶方向', '启动驱动', '保持目标速度', '减速停止'],
    },
    {
      id: 'reverse',
      label: '倒车',
      aliases: ['后退'],
      durationMs: 4200,
      stages: ['检查倒车方向', '启动倒车', '保持目标速度', '减速停止'],
    },
    {
      id: 'turn_left',
      label: '向左转',
      aliases: ['左转'],
      durationMs: 2800,
      stages: ['锁定转向角度', '启动转向', '调整朝向', '转向结束'],
    },
    {
      id: 'turn_right',
      label: '向右转',
      aliases: ['右转'],
      durationMs: 2800,
      stages: ['锁定转向角度', '启动转向', '调整朝向', '转向结束'],
    },
    {
      id: 'park',
      label: '泊车',
      aliases: ['停车入位'],
      durationMs: 3000,
      stages: ['降低车速', '调整车身位置', '停止驱动', '进入泊车状态'],
    },
    {
      id: 'stop',
      label: '停止',
      aliases: ['停下', '急停'],
      durationMs: 1000,
      stages: ['接收停止请求', '降低车速', '停止驱动', '进入待命'],
    },
  ].map(Object.freeze),
)

export const ACTIONS_BY_DEVICE = Object.freeze({ robot_dog: DOG_ACTIONS, robot_car: CAR_ACTIONS })

export function resolveAction(deviceType, requested) {
  const actions = ACTIONS_BY_DEVICE[deviceType] ?? []
  const normalized = String(requested).trim().toLowerCase()
  return actions.find(
    (action) =>
      action.id === normalized ||
      action.label.toLowerCase() === normalized ||
      action.aliases.some((alias) => alias.toLowerCase() === normalized),
  )
}
