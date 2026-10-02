# MHS Device Control

An installable full-stack Agnes Harness plugin that exposes robot-dog and robot-car tools, emits a
detailed operation event stream, and renders the same five-step operation in the conversation and
a floating workbench panel. The panel shows each event as it arrives and retains recent commands
across turns in the same session.

The included event-loopback implementation produces the device lifecycle and receipt. It does not
connect a vendor SDK or physical device. A verified MCP adapter can replace this implementation.

## Tools

- `mhs_list_devices`: lists available devices and supported actions.
- `mhs_get_device_state`: reads one device's current state.
- `mhs_control_device`: runs one action and returns an execution receipt.

The robot dog accepts `stand`, `lie_down`, `sit`, `heart`, `new_year_greeting`, `dance`, `stretch`,
`front_pounce`, `front_flip`, `back_flip`, `left_flip`, `front_jump`, `hello`, movement, turning,
and `stop`. Chinese action names and common aliases are accepted. The robot car accepts forward,
reverse, turning, parking, and stop commands. The dog action vocabulary follows Unitree's
[Go2 SportClient](https://github.com/unitreerobotics/unitree_sdk2/blob/main/include/unitree/robot/go2/sport/sport_client.hpp)
and [Go2 App descriptions](https://www.unitree.com/cn/app/go2/). `new_year_greeting` is an
application-level presentation sequence, not a one-to-one SportClient method. Availability on a
particular physical Go2 model and firmware is not verified by this package.

Example request:

> List the available robot dogs, then make robot-dog-01 move forward for four seconds.

Each control call emits planning, five TODO steps, dispatch, acceptance, motion progress, state,
receipt, and task-completion events. The browser obtains incremental event snapshots through the
same-row query service; the existing `ToolContext.progress` callback is currently not projected
into the Web conversation. Operations are retained per session so later turns can issue another
command while the panel keeps recent history.

## Install

Build and start Agnes Harness with an isolated profile whose capability ceiling includes `services`,
then inspect and install this package through the normal package lifecycle:

```sh
node packages/cli/dist/local/agnes.mjs package inspect file:./examples/packages/mhs-device-control
node packages/cli/dist/local/agnes.mjs install file:./examples/packages/mhs-device-control
```

Trust and enable the exact hashes returned by inspection. Open a Web session before enabling the
package so its browser row has an active session for the `mhs.operation.snapshot` query.

## Boundaries

The package uses the public `workbench.panel` and `tool.call.toolview` slots, plus the same-row
constrained service relay. The Host supplies the validated session ID to the query handler through
`ServiceContext.sessionId`; the browser sends no session identifier in query input. The built-in
sidebar and trace view remain available. If the event-loopback implementation is changed to perform
external effects, update tool approval, replay, cancellation, receipt, and physical-safety behavior
together.
