// The host owns the one browser copy of Ant Design. The actual dependency import stays inside
// web-ui so the dependency fence remains meaningful; React and its JSX/runtime entry points remain
// external so every app and plugin resolves them through the same import map instance.
export * from '../../../web-ui/src/antd-vendor.js'
