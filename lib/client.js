/* verme-gate 0.3.26 — сгенерировано scripts/build-client.mjs, не редактировать вручную. */
window.__ModuleLoader__.load({ id: "verme-gate", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
'use strict'

/**
 * Клиентская половина dsh-mcp-access: экран настроек внутри DSH.
 *
 * Регистрируется в слоте settings.section (страница в Settings, как у сторонних плагинов).
 * Данные берёт из HTTP-ручек самого плагина на том же origin (периметр проверяет
 * connection.requestRejection на стороне хоста). Сохранённые секреты не запрашиваются
 * и не отображаются: state отдаёт только факт наличия и результат проверки.
 */

const React = require('react')
const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

const h = React.createElement
const useEffect = React.useEffect
const useMemo = React.useMemo
const useRef = React.useRef
const useState = React.useState
const useCallback = React.useCallback

const Button = primitives.Button
const Modal = primitives.Modal

const NS = 'mcp.access'
// 'sessions' нужен разделу «Промпты»: текст кладётся в черновик через SessionInput.setDraft,
// а не правкой contenteditable — иначе проекция Lexical-редактора разъезжается с DOM.
const inject = ['slots', 'sessions', 'conversation']
const API = '/verme-gate/api'

const STYLE = [
'.dshMcp{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}',
'.dshMcpHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}',
'.dshMcpTitle{margin:0;font-size:18px;line-height:26px;font-weight:600}',
'.dshMcpHint{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpActions{display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap}',
'.dshMcpTabs{display:flex;gap:22px;border-bottom:.5px solid var(--dsw-alias-border-l2)}',
'.dshMcpTab{position:relative;padding:0 0 10px;border:0;background:none;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
'.dshMcpTab[aria-selected=true]{color:var(--dsw-alias-label-primary)}',
'.dshMcpTab[aria-selected=true]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-label-primary)}',
'.dshMcpTab:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:4px}',
'.dshMcpStack{display:flex;flex-direction:column;gap:16px}',
'.dshMcpCard{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px}',
'.dshMcpCardHead{display:flex;align-items:center;justify-content:space-between;gap:12px}',
'.dshMcpCardTitle{margin:0;font-size:14px;line-height:22px;font-weight:600}',
'.dshMcpCardNote{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
'.dshMcpRow:last-child{border-bottom:0}',
'.dshMcpRowMain{min-width:0;display:flex;flex-direction:column;gap:2px}',
'.dshMcpRowTitle{font-size:13px;line-height:20px}',
'.dshMcpRowMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpField{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-top:12px}',
'.dshMcpFieldLabel{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:220px}',
'.dshMcpSelect,.dshMcpInput{box-sizing:border-box;height:36px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;padding:0 11px;min-width:0}',
'.dshMcpSelect{cursor:pointer;padding-right:28px}',
'.dshMcpInput{width:100%}',
'.dshMcpSelect:focus-visible,.dshMcpInput:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}',
'.dshMcpPill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:17px;font-weight:500;white-space:nowrap}',
'.dshMcpPill--ok{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-success-primary)}',
'.dshMcpPill--warn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary)}',
'.dshMcpPill--bad{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}',
'.dshMcpPill--idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
'.dshMcpDot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}',
'.dshMcpSrv{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
'.dshMcpSrvList{display:flex;flex-direction:column;gap:10px;margin-top:10px}',
'.dshMcpSrvBlock{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-left-width:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
'.dshMcpSrvBlock--ok{border-left-color:var(--dsw-alias-state-success-primary)}',
'.dshMcpSrvBlock--warn{border-left-color:var(--dsw-alias-state-warn-primary)}',
'.dshMcpSrvBlock--bad{border-left-color:var(--dsw-alias-state-error-primary)}',
'.dshMcpSrvBlock--idle{border-left-color:var(--dsw-alias-border-l2)}',
'.dshMcpSrvMain{min-width:0;display:flex;flex-direction:column;gap:2px}',
'.dshMcpServerTitle{font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}',
'.dshMcpSrvTools{padding:0}',
'.dshMcpHeaders{display:flex;flex-direction:column;gap:6px}',
'.dshMcpHeaderRow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
'.dshMcpHeaderName{display:flex;flex-direction:column;gap:2px;min-width:180px}',
'.dshMcpHeaderRow .dshMcpInput{flex:1 1 200px;width:auto}',
'.dshMcpSrvLine{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
'.dshMcpChips{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
'.dshMcpChipCode{font-size:11px;line-height:17px;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}',
'.dshMcpDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.dshMcpDot--ok{color:var(--dsw-alias-state-success-primary)}',
'.dshMcpDot--warn{color:var(--dsw-alias-state-warn-primary)}',
'.dshMcpDot--bad{color:var(--dsw-alias-state-error-primary)}',
'.dshMcpDot--idle{color:var(--dsw-alias-label-tertiary)}',
'.dshMcpToolsBox{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
'.dshMcpTool{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;min-width:0}',
'.dshMcpTool code{font-family:var(--dsw-font-family);overflow-wrap:anywhere}',
'.dshMcpToolState{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
'.dshMcpTool--off code{color:var(--dsw-alias-label-secondary)}',
'.dshMcpEmpty{padding:22px 16px;text-align:center;border:.5px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpNotice{display:flex;align-items:flex-start;gap:8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpNotice--bad{color:var(--dsw-alias-state-error-primary)}',
'.dshMcpNotice--warn{color:var(--dsw-alias-state-warn-primary)}',
'.dshMcpNotice--ok{color:var(--dsw-alias-state-success-primary)}',
'.dshMcpNotices{display:flex;flex-direction:column;gap:8px}',
'.dshMcpVerdict--ok{color:var(--dsw-alias-state-success-primary)}',
'.dshMcpVerdict--warn{color:var(--dsw-alias-state-warn-primary)}',
'.dshMcpVerdict--bad{color:var(--dsw-alias-state-error-primary)}',
'.dshMcpFoot{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
'.dshMcpBar{height:6px;border-radius:3px;background:var(--dsw-alias-border-l1);overflow:hidden;margin:8px 0 0}',
'.dshMcpBarFill{height:100%;border-radius:3px;background:var(--dsw-alias-state-business-primary, #4176e6);transition:width .2s ease}',
'.dshMcpBarFill--warn{background:var(--dsw-alias-state-warn-primary)}',
'.dshMcpBarFill--bad{background:var(--dsw-alias-state-error-primary)}',
// Чип бюджета под композером: одна строка с расходом и полоской, подробности — по наведению.
'.dshBudgetChip{position:relative;display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:default;outline:none;border-radius:var(--dsw-radius-sm);padding:0 2px}',
'.dshBudgetChip:hover,.dshBudgetChip:focus-visible{color:var(--dsw-alias-label-secondary)}',
'.dshBudgetChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2)}',
'.dshBudgetChipTrack{display:block;width:44px;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}',
'.dshBudgetChipFill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary, #4176e6);transition:width .2s ease}',
'.dshBudgetChipFill--warn{background:var(--dsw-alias-state-warn-primary)}',
'.dshBudgetChipFill--bad{background:var(--dsw-alias-state-error-primary)}',
'.dshBudgetTip{position:absolute;bottom:calc(100% + 8px);right:0;z-index:40;pointer-events:none;max-height:min(60vh,320px);overflow:auto;min-width:220px;max-width:min(320px,calc(100vw - 32px));padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:left;white-space:normal}',
'.dshBudgetTipHead{font-weight:600;color:var(--dsw-alias-label-primary)}',
'.dshBudgetTipRow{display:flex;justify-content:space-between;gap:14px}',
'.dshBudgetTipValue{color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}',
// Чип обновления рядом с бюджетом: новая версия и/или несовместимая сборка DSH.
'.dshUpdateChip{position:relative;display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-business-primary,#4176e6);cursor:pointer;outline:none;border-radius:var(--dsw-radius-sm);padding:0 2px}',
'.dshUpdateChip--warn{color:var(--dsw-alias-state-warn-primary)}',
'.dshUpdateChip:hover,.dshUpdateChip:focus-visible{text-decoration:underline}',
'.dshUpdateChip:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l2)}',
'.dshUpdateDot{display:inline-block;width:6px;height:6px;border-radius:999px;background:currentColor}',
'.dshUpdateTip{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;min-width:260px;max-width:min(380px,calc(100vw - 32px));padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);text-align:left;white-space:normal;cursor:default}',
'.dshUpdateTipHead{font-weight:600;color:var(--dsw-alias-label-primary)}',
'.dshUpdateCmd{display:block;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:15px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2,#f3f4f6);border-radius:6px;padding:6px 8px;white-space:pre-wrap;word-break:break-all}',
'.dshUpdateRow{display:flex;justify-content:space-between;gap:12px}',
'.dshUpdateValue{color:var(--dsw-alias-label-primary);white-space:nowrap}',
'.dshUpdateLink{color:var(--dsw-alias-state-business-primary,#4176e6);cursor:pointer;text-decoration:none}',
'.dshUpdateLink:hover{text-decoration:underline}',
// Карточка денег: герой с остатком, плитки, столбики по дням, таблица моделей.
'.dshMoneyHero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
'.dshMoneyHeroTop{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}',
'.dshMoneyLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
'.dshMoneyValue{font-size:24px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums}',
'.dshMoneySpent{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}',
'.dshMoneyRight{text-align:right}',
'.dshMoneySub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMoneyBar{height:6px}',
'.dshMoneyTiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:12px}',
'.dshMoneyTile{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);min-width:0}',
'.dshMoneyTileLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
'.dshMoneyTileValue{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'.dshMoneySection{display:flex;flex-direction:column;gap:8px;margin-top:16px}',
'.dshMoneySectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMoneySectionMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
'.dshMoneyDays{display:flex;align-items:flex-end;gap:6px;height:64px}',
'.dshMoneyDay{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:4px;height:100%;min-width:0;border:0;background:none;padding:0;font-family:inherit;cursor:pointer}',
'.dshMoneyDay:hover .dshMoneyDayLabel{color:var(--dsw-alias-label-secondary)}',
'.dshMoneyDay--active .dshMoneyDayLabel{color:var(--dsw-alias-label-primary);font-weight:600}',
'.dshMoneyDay--active .dshMoneyDayBar{background:var(--dsw-alias-state-business-primary, #4176e6);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base), 0 0 0 2.5px var(--dsw-alias-state-business-primary, #4176e6)}',
'.dshMoneyDay:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:var(--dsw-radius-sm)}',
'.dshMoneyDayBar{width:100%;max-width:34px;border-radius:3px 3px 0 0;background:var(--dsw-alias-state-business-primary, #4176e6);min-height:2px}',
'.dshMoneyDayBar--muted{background:var(--dsw-alias-border-l2)}',
'.dshMoneyDayLabel{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
'.dshMoneyTable{display:flex;flex-direction:column;gap:6px}',
'.dshMoneyRow{display:grid;grid-template-columns:minmax(0,1fr) 96px 64px;align-items:center;gap:10px;font-size:12px;line-height:18px}',
'.dshMoneyRowName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}',
'.dshMoneyRowShare{display:block;height:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden}',
'.dshMoneyRowShareFill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary, #4176e6)}',
'.dshMoneyRowValue{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
'.dshMoneyToggle{align-self:flex-start;border:0;background:none;padding:0;font-family:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
'.dshMoneyToggle:hover{color:var(--dsw-alias-label-primary)}',
'.dshBudgetTipFoot{margin:2px 0 0;color:var(--dsw-alias-label-tertiary)}',
  '.dshMcpChecks{display:flex;flex-direction:column;gap:6px;margin:0 0 4px;max-height:220px;overflow:auto}',
  '.dshMcpBlock{margin:0 0 12px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}',
  '.dshMcpBlockHead{margin:0 0 6px;font-size:11px;line-height:16px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
  '.dshMcpCheck{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;cursor:pointer}',
  '.dshMcpCheck input{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary, #4176e6)}',
'.dshMcpList{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:8px}',
'.dshMcpChip{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:5px 9px;font-size:12px;line-height:18px}',
'.dshMcpKv{display:grid;grid-template-columns:minmax(140px,1fr) minmax(0,1.4fr);gap:8px 16px;margin:0;font-size:12px;line-height:18px}',
'.dshMcpKv dt{color:var(--dsw-alias-label-secondary)}',
'.dshMcpKv dd{margin:0;overflow-wrap:anywhere}',
'.dshMcpDetails{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px}',
'.dshMcpDetails summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
'.dshMcpScroll{max-height:150px;overflow-y:auto;margin:8px 0 0}',
'.dshMcpPre{margin:10px 0 0;font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
'.dshMcpModalBody{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:20px}',
'.dshMcpModalText{margin:0;color:var(--dsw-alias-label-secondary)}',
'@media (max-width:720px){.dshMcpField{flex-direction:column;align-items:stretch}}',
].join('\n')

/** Имя модели без провайдерских префиксов: openrouter/…/claude-opus-5.5 → claude-opus-5.5. */
function shortModel(name) {
  const parts = String(name).split('/')
  return parts[parts.length - 1]
}

/** Деньги в сводке по дням: 2026-10-27 → 27.10. */
function shortDay(day) {
  const parts = String(day).split('-')
  return parts.length === 3 ? parts[2] + '.' + parts[1] : String(day)
}

function callApi(method, path, body) {
  const init = { method, headers: {}, credentials: 'same-origin' }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return fetch(API + path, init).then((response) => response.text().then((text) => {
    let payload = null
    try {
      payload = text === '' ? null : JSON.parse(text)
    } catch {
      payload = null
    }
    if (!response.ok) {
      const detail = payload !== null && typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
      throw new Error(detail)
    }
    return payload
  }))
}

function clockOf(stamp) {
  if (!stamp) return ''
  const date = new Date(stamp)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  if (sameDay) return 'сегодня, ' + time
  return String(date.getDate()).padStart(2, '0') + '.' + String(date.getMonth() + 1).padStart(2, '0') + ', ' + time
}

const PHASES = {
  ready: { label: 'Подключено', tone: 'ok' },
  starting: { label: 'Идёт подключение', tone: 'warn' },
  switching: { label: 'применяется…', tone: 'warn' },
  degraded: { label: 'Частично недоступно', tone: 'bad' },
  idle: { label: 'Ожидание', tone: 'idle' },
}

// Вердикт проверки ключа в строке сервера: одна метка на строку, подробности — в title.
const VERDICTS = {
  'token-ok': { label: 'ключ принят', tone: 'ok' },
  'token-rejected': { label: 'ключ отклонён', tone: 'bad' },
  'token-unknown': { label: 'ключ не проверен', tone: 'warn' },
}

function verdictOf(server) {
  return VERDICTS[server.tokenStatus] || null
}

// id для aria-controls раскрываемой панели сервера (имя сервера может быть любым).
function panelIdOf(kind, name) {
  return 'dshMcp' + kind + '-' + String(name || '').replace(/[^a-zA-Z0-9_-]/g, '-') + '-panel'
}

// Подсказка вердикта: причина и код от шлюза, возраст — по времени проверки.
function verdictHintOf(server) {
  const parts = []
  const login = String(server.tokenLogin || '')
  if (login !== '') parts.push(login)
  const reason = String(server.tokenReason || '')
  if (reason !== '') parts.push(reason)
  const code = Number(server.tokenHttpCode || 0)
  if (code > 0) parts.push('HTTP ' + String(code))
  const checkedAt = clockOf(server.tokenCheckedAt)
  if (checkedAt !== '') parts.push('проверено ' + checkedAt)
  return parts.join(' · ')
}

// Ответ /verify говорит, чем закончилась проверка: без этого экран писал «выполнена» и при отказе.
function verifyNoticeOf(payload) {
  const list = payload !== null && payload !== undefined && Array.isArray(payload.verify) ? payload.verify : []
  if (list.length === 0) return { text: 'Проверка не выполнена.', tone: 'warn' }
  const first = list[0] !== null && typeof list[0] === 'object' ? list[0] : {}
  const reason = String(first.reason || '')
  if (first.status === 'token-ok') return { text: 'Ключ принят.', tone: 'ok' }
  if (first.status === 'token-rejected') {
    return { text: 'Ключ отклонён: ' + (reason !== '' ? reason : 'причина не сообщена'), tone: 'bad' }
  }
  if (first.status === 'token-unknown') {
    return { text: 'Проверка недоступна: ' + (reason !== '' ? reason : 'причина не сообщена'), tone: 'warn' }
  }
  return { text: 'Проверка не выполнена.', tone: 'warn' }
}

function pill(text, tone) {
  return h('span', { className: 'dshMcpPill dshMcpPill--' + (tone || 'idle') },
    h('span', { className: 'dshMcpDot', 'aria-hidden': 'true' }), text)
}

function allowListOf(server) {
  const allow = Array.isArray(server.toolAllow) ? server.toolAllow : []
  if (allow.indexOf('*') !== -1) return null
  return allow
}

function obtainedToolsOf(server) {
  const raw = Array.isArray(server.mountedTools) ? server.mountedTools : []
  const prefix = 'mcp__' + String(server.name) + '__'
  return raw.map((full) => ({
    full: full,
    id: full.indexOf(prefix) === 0 ? full.slice(prefix.length) : full,
  }))
}

function allowedToolsOf(server) {
  const obtained = obtainedToolsOf(server)
  const allow = allowListOf(server)
  if (allow === null) return obtained
  return obtained.filter((tool) => allow.indexOf(tool.id) !== -1)
}

function loginText(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return text.indexOf('login=') === 0 ? text.slice(6) : text
}

function currentModelText(current) {
  if (current === null || current === undefined) return ''
  if (typeof current === 'string') return current
  const provider = current.provider ? String(current.provider) : ''
  const model = current.model ? String(current.model) : ''
  if (provider !== '' && model !== '') return provider + ' · ' + model
  return model !== '' ? model : provider
}

const SERVER_STATES = {
  mounted: { label: 'подключён', tone: 'ok' },
  starting: { label: 'подключается…', tone: 'warn' },
  failed: { label: 'ошибка', tone: 'bad' },
  'token-rejected': { label: 'ключ отклонён', tone: 'bad' },
  'key-error': { label: 'ошибка ключа', tone: 'bad' },
  'no-token': { label: 'нужен ключ', tone: 'warn' },
  'no-active-token': { label: 'нет подключения', tone: 'idle' },
  'no-env': { label: 'нужен ключ сервиса', tone: 'warn' },
  'no-header': { label: 'нужен заголовок', tone: 'warn' },
  'not-mounted': { label: 'не подключён', tone: 'idle' },
}

function serverStateOf(server) {
  return SERVER_STATES[server.status] || { label: 'Состояние не распознано', tone: 'idle' }
}

// Чего сервер не хватает: только имена (переменные шлюза и заголовки). Описание каждого
// имени уходит в подсказку, в строке оно не печатается. Источник — объявление сервера.
function requirementChips(server) {
  const chips = []
  const envRequired = Array.isArray(server.envRequired) ? server.envRequired : []
  envRequired.forEach((item) => {
    if (item === null || item === undefined) return
    const name = String(item.name || '')
    if (name === '') return
    chips.push({ name: name, hint: String(item.description || '') })
  })
  headerListOf(server).forEach((item) => chips.push({ name: item.name, hint: 'заголовок сервиса' }))
  // Прочие требования шлюза — короткой меткой, подробности в подсказке.
  const authType = String(server.authType || '')
  if (authType !== '' && authType !== 'none') chips.push({ name: 'авторизация: ' + authType, hint: 'у шлюза' })
  const byokWords = Array.isArray(server.byokDescription) ? server.byokDescription.join(' ') : ''
  if (server.isByok === true) chips.push({ name: 'свой ключ', hint: byokWords })
  else if (server.hasUserCredential === true && envRequired.length === 0) {
    chips.push({ name: 'личные креды', hint: 'у шлюза' })
  }
  return chips
}

// Заголовки сервера: требования из записи шлюза плюс уже заданные значения (объединение по имени).
function headerListOf(server) {
  const out = []
  const index = {}
  const push = (name, isSet, source) => {
    if (name === '') return
    if (index[name] === undefined) {
      index[name] = out.length
      out.push({ name: name, isSet: isSet === true, source: source || '' })
      return
    }
    if (isSet === true) out[index[name]].isSet = true
  }
  const required = Array.isArray(server.headerRequired) ? server.headerRequired : []
  required.forEach((item) => {
    if (item === null || item === undefined) return
    push(String(item.name || ''), item.isSet === true, String(item.source || ''))
  })
  const stored = Array.isArray(server.headerSet) ? server.headerSet : []
  stored.forEach((name) => push(String(name || ''), true, 'stored'))
  return out
}

function Notice(props) {
  if (props.text === null || props.text === undefined || props.text === '') return null
  let cls = 'dshMcpNotice'
  if (props.tone === 'bad') cls += ' dshMcpNotice--bad'
  else if (props.tone === 'warn') cls += ' dshMcpNotice--warn'
  else if (props.tone === 'ok') cls += ' dshMcpNotice--ok'
  return h('div', {
    className: cls,
    role: props.tone === 'bad' ? 'alert' : 'status',
    title: props.title === undefined ? undefined : props.title,
  }, props.text)
}

function ToolsList(props) {
  const obtained = obtainedToolsOf(props.server)
  if (obtained.length === 0) {
    return h('div', { className: 'dshMcpEmpty' }, 'Пока пусто.')
  }
  const allow = allowListOf(props.server)
  return h('div', { className: 'dshMcpToolsBox' }, obtained.map((tool) => {
    const allowed = allow === null || allow.indexOf(tool.id) !== -1
    return h('div', { className: 'dshMcpTool' + (allowed ? '' : ' dshMcpTool--off'), key: tool.full, title: tool.full },
      h('code', null, tool.id),
      h('span', { className: 'dshMcpToolState' }, allowed ? '' : 'скрыт в DSH'))
  }))
}

// Заголовки, которые сервис требует от клиента (например X-Redmine-User-Key): имя приходит из
// записи сервера в шлюзе, значение вводит человек и уходит только в credential-store плагина.
function ServerHeaders(props) {
  const items = headerListOf(props.server)
  const [draft, setDraft] = useState({})
  const [custom, setCustom] = useState({ name: '', value: '' })
  const busy = props.busy === true
  const save = (name, value) => {
    if (name === '') return Promise.resolve(null)
    return props.onSaveHeader(props.server.name, name, value).then((payload) => {
      // Поле чистим только после успешной записи: при отказе введённое остаётся на экране.
      if (payload === null) return payload
      setDraft((previous) => {
        const next = Object.assign({}, previous)
        delete next[name]
        return next
      })
      return payload
    })
  }
  return h('div', { className: 'dshMcpHeaders' },
    items.length === 0 ? null : items.map((item) => h('div', { className: 'dshMcpHeaderRow', key: item.name },
      h('code', null, item.name),
      h('span', { className: 'dshMcpRowMeta' }, item.isSet ? 'задан' : 'не задан'),
        h('input', {
          className: 'dshMcpInput',
          type: 'password',
          autoComplete: 'off',
          'aria-label': 'Значение заголовка ' + item.name,
          name: 'header-' + item.name,
          placeholder: 'значение',
          value: draft[item.name] === undefined ? '' : draft[item.name],
          disabled: busy,
          onChange: (event) => {
            const value = event.target.value
            setDraft((previous) => Object.assign({}, previous, { [item.name]: value }))
          },
        }),
        h(Button, {
          variant: 'outline',
          disabled: busy || String(draft[item.name] || '') === '',
          onClick: () => save(item.name, String(draft[item.name] || '').trim()),
        }, 'Сохранить'),
        item.isSet ? h(Button, { variant: 'outline', disabled: busy, onClick: () => save(item.name, '') }, 'Снять') : null)),
    h('details', { className: 'dshMcpDetails', open: false },
      h('summary', null, 'Свой заголовок'),
      h('div', { className: 'dshMcpHeaderRow', key: 'custom' },
        h('input', {
          className: 'dshMcpInput',
          'aria-label': 'Имя заголовка',
          name: 'header-name',
          placeholder: 'Имя, например X-Service-Token',
          value: custom.name,
          disabled: busy,
          onChange: (event) => setCustom({ name: event.target.value, value: custom.value }),
        }),
        h('input', {
          className: 'dshMcpInput',
          type: 'password',
          autoComplete: 'off',
          'aria-label': 'Значение нового заголовка',
          name: 'header-value',
          placeholder: 'Значение',
          value: custom.value,
          disabled: busy,
          onChange: (event) => setCustom({ name: custom.name, value: event.target.value }),
        }),
        h(Button, {
          variant: 'outline',
          disabled: busy || custom.name.trim() === '' || custom.value.trim() === '',
          onClick: () => {
            const name = custom.name.trim()
            const value = custom.value.trim()
            save(name, value).then((payload) => {
              if (payload !== null) setCustom({ name: '', value: '' })
            })
          },
        }, 'Сохранить'))),
    h('p', { className: 'dshMcpFoot' }, 'обратно не показывается'))
}

// Личные переменные, которые требует сервер (REDMINE_PERSONAL_KEY и т.п.). Значение пишется
// прямо в шлюз ключом пользователя (POST /v1/mcp/server/<id>/user-env-vars), в плагине не
// хранится, на экран больше не возвращается — видно только «задан / не задан».
function ServerEnvVars(props) {
  const items = Array.isArray(props.server.envRequired) ? props.server.envRequired : []
  const [draft, setDraft] = useState({})
  const busy = props.busy === true
  const anySet = items.some((item) => item !== null && item !== undefined && item.isSet === true)
  const save = (name, value) => {
    if (name === '') return Promise.resolve(null)
    return props.onSaveEnvVar(props.server.name, name, value).then((payload) => {
      // Поле чистим только после успешной записи: введённое значение не теряется при отказе.
      if (payload === null) return payload
      setDraft((previous) => {
        const next = Object.assign({}, previous)
        delete next[name]
        return next
      })
      return payload
    })
  }
  if (items.length === 0) return null
  // Плейсхолдер режется по словам: полный текст остаётся в title поля.
  const shortHint = (item) => {
    const words = String(item.description || '').trim()
    if (words === '') return 'значение'
    if (words.length <= 48) return words
    const cut = words.slice(0, 48)
    const space = cut.lastIndexOf(' ')
    return (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
  }
  return h('div', { className: 'dshMcpHeaders' },
    items.map((item) => h('div', { className: 'dshMcpHeaderRow', key: String(item.name || '') },
      h('code', { title: String(item.description || '') }, String(item.name || '')),
      h('span', { className: 'dshMcpRowMeta' }, item.isSet === true ? 'задан' : 'не задан'),
      h('input', {
        className: 'dshMcpInput',
        type: 'password',
        autoComplete: 'off',
        'aria-label': 'Значение переменной ' + String(item.name || ''),
        name: 'env-' + String(item.name || ''),
        placeholder: shortHint(item),
        title: String(item.description || ''),
        value: draft[item.name] === undefined ? '' : draft[item.name],
        disabled: busy,
        onChange: (event) => {
          const value = event.target.value
          setDraft((previous) => Object.assign({}, previous, { [item.name]: value }))
        },
      }),
      h(Button, {
        variant: 'outline',
        disabled: busy || String(draft[item.name] || '') === '',
        onClick: () => save(String(item.name || ''), String(draft[item.name] || '').trim()),
      }, 'Сохранить'))),
    anySet
      ? h('div', { className: 'dshMcpActions' },
        h(Button, { variant: 'outline', disabled: busy, onClick: () => props.onClearEnvVars(props.server.name) },
          'Снять'))
      : null,
    h('p', { className: 'dshMcpFoot' }, 'хранится в шлюзе, обратно не показывается'))
}

const POLL_DELAY_MS = 2000
const POLL_MAX = 15

// Состояние ещё меняется само: подключение, переключение токена или ожидание применения.
function needsPoll(data) {
  if (data === null || data === undefined) return false
  const phase = String(data.phase || '')
  if (phase === 'starting' || phase === 'switching') return true
  if (Number(data.applyPending) > 0) return true
  const servers = Array.isArray(data.servers) ? data.servers : []
  return servers.some((server) => server !== null && server !== undefined && server.status === 'starting')
}

function useMcpState() {
  const [state, setState] = useState({ status: 'loading', data: null, error: '' })
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState('')
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const apply = useCallback((payload, message, tone) => {
    if (!mounted.current) return
    if (payload !== null && typeof payload === 'object') setState({ status: 'ready', data: payload, error: '' })
    if (message !== undefined) setNotice(message === null ? null : { text: message, tone: tone || 'info' })
  }, [])

  const reload = useCallback(() => {
    setBusy('refresh')
    return callApi('GET', '/state').then((payload) => {
      apply(payload)
      setNotice(null)
    }).catch((error) => {
      if (mounted.current) setState({ status: 'error', data: null, error: String(error.message || error) })
    }).finally(() => { if (mounted.current) setBusy('') })
  }, [apply])

  useEffect(() => { reload() }, [reload])

  // Пока идёт монтирование серверов, экран сам подтягивает состояние: иначе после подключения
  // список инструментов остаётся пустым, хотя они уже пришли (фаза starting -> ready).
  // Тихо: без индикатора занятости и без стирания сообщения об успехе. Тихий ответ приносит тот же
  // phase, поэтому таймер перевзводится по тику, а не по смене фазы; серия ограничена 15 опросами.
  const pollCount = useRef(0)
  const pollToken = useRef('')
  const pollErrorShown = useRef(false)
  const [pollTick, setPollTick] = useState(0)
  const reloadSilent = useCallback(() => callApi('GET', '/state').then((payload) => {
    if (!mounted.current) return
    pollErrorShown.current = false
    if (payload !== null && typeof payload === 'object') setState({ status: 'ready', data: payload, error: '' })
  }).catch((error) => {
    if (!mounted.current) return
    if (!pollErrorShown.current) {
      pollErrorShown.current = true
      setNotice({ text: 'Не удалось обновить состояние: ' + String(error.message || error), tone: 'warn' })
    }
    // Неудачный опрос не меняет данные: тик перевзводит таймер до следующей попытки.
    setPollTick((value) => value + 1)
  }), [])
  useEffect(() => {
    const data = state.data
    const activeToken = data !== null && data !== undefined ? String(data.activeToken || '') : ''
    if (pollToken.current !== activeToken) {
      pollToken.current = activeToken
      pollCount.current = 0
      pollErrorShown.current = false
    }
    if (state.status !== 'ready' || !needsPoll(data)) {
      pollCount.current = 0
      return undefined
    }
    if (pollCount.current >= POLL_MAX) return undefined
    const timer = setTimeout(() => {
      pollCount.current += 1
      reloadSilent()
    }, POLL_DELAY_MS)
    return () => clearTimeout(timer)
  }, [state, pollTick, reloadSilent])

  // noticeOf(payload) задаёт сообщение по ответу ручки; по умолчанию — текст действия.
  const run = useCallback((key, path, body, successText, noticeOf) => {
    setBusy(key)
    setNotice(null)
    return callApi('POST', path, body === undefined ? {} : body).then((payload) => {
      if (typeof noticeOf === 'function') {
        const note = noticeOf(payload)
        apply(payload, note === null || note === undefined ? null : note.text, note === null || note === undefined ? 'info' : note.tone)
        return payload
      }
      const phase = payload !== null && payload !== undefined ? payload.phase : undefined
      let extra = ''
      if (phase === 'starting') extra = ' Подключение ещё идёт — обновите состояние через несколько секунд.'
      apply(payload, successText + extra, phase === 'degraded' ? 'warn' : 'info')
      return payload
    }).catch((error) => {
      if (mounted.current) setNotice({ text: 'Не удалось выполнить действие: ' + String(error.message || error), tone: 'bad' })
      return null
    }).finally(() => { if (mounted.current) setBusy('') })
  }, [apply])

  return { state, notice, busy, reload, run, reloadSilent }
}


function ConnectKeyDialog(props) {
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [probe, setProbe] = useState(null)
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState('')
  const [activate, setActivate] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const probeSeq = useRef(0)
  const labelTouched = useRef(false)
  // Любой ввод сбрасывает прошлый вердикт: он относился к другому ключу. Дебаунс-таймер снимается
  // в cleanup, поэтому старый запрос не перезапишет новый вердикт.
  useEffect(() => {
    probeSeq.current += 1
    const seq = probeSeq.current
    setProbe(null)
    setProbeError('')
    const trimmed = key.trim()
    if (trimmed.length < 12) {
      setProbing(false)
      return undefined
    }
    setProbing(true)
    const timer = setTimeout(() => {
      callApi('POST', '/key-probe', { key: trimmed }).then((payload) => {
        if (probeSeq.current !== seq) return
        setProbe(payload === null ? {} : payload)
        setProbeError('')
        if (!labelTouched.current && payload !== null && typeof payload === 'object') {
          setLabel('Ключ …' + trimmed.slice(-4))
        }
      }).catch((failure) => {
        if (probeSeq.current !== seq) return
        setProbe(null)
        setProbeError(String(failure.message || failure))
      }).finally(() => {
        if (probeSeq.current === seq) setProbing(false)
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [key])
  const servers = probe !== null && Array.isArray(probe.servers) ? probe.servers : []
  const models = probe !== null && Array.isArray(probe.models) ? probe.models : []
  const ready = probe !== null && probeError === '' && saving === false
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    closeLabel: 'Закрыть',
    title: props.mode === 'replace' ? 'Заменить ключ' : 'Подключить по ключу',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', onClick: props.onClose }, 'Отмена'),
      h(Button, {
        key: 'connect',
        variant: 'primary',
        disabled: ready !== true,
        onClick: () => {
          setSaving(true)
          setError('')
          props.onConnect({ key: key.trim(), label: label.trim(), activate: activate }).then((payload) => {
            if (payload === null) setError('Не подключено: смотрите сообщение вверху экрана.')
            else props.onClose()
          }).finally(() => setSaving(false))
        },
      }, saving ? 'Подключаем…' : (props.mode === 'replace' ? 'Заменить ключ' : 'Подключить')),
    ],
  },
  h('div', { className: 'dshMcpModalBody' },
    h('p', { className: 'dshMcpModalText' }, props.mode === 'replace'
      ? 'Вставьте новый ключ LiteLLM: экран спросит у шлюза, что он разрешает, и покажет это до сохранения. Старый ключ перестанет действовать.'
      : 'Вставьте ключ LiteLLM: экран спросит у шлюза, что ключ разрешает, и покажет серверы и модели до сохранения. Название токена он придумает сам.'),
    h('label', { className: 'dshMcpFieldLabel', htmlFor: 'dshMcpKeyInput' }, 'Ключ LiteLLM',
      h('input', {
        id: 'dshMcpKeyInput',
        className: 'dshMcpInput',
        type: 'password',
        autoComplete: 'off',
        spellCheck: false,
        placeholder: 'sk-…',
        value: key,
        onChange: (event) => setKey(event.target.value),
      })),
    probing ? h('p', { className: 'dshMcpFoot' }, 'Спрашиваю шлюз, что разрешает этот ключ…') : null,
    probeError === '' ? null : h(Notice, { text: probeError, tone: 'bad' }),
    probe === null ? null : h('div', { className: 'dshMcpBlock' },
      h('div', { className: 'dshMcpBlockHead' }, 'Серверы: ' + servers.length),
      servers.length === 0
        ? h('p', { className: 'dshMcpFoot' }, 'Ключ не даёт ни одного MCP-сервера: подключать нечего, проверьте права ключа в шлюзе.')
        : h('ul', { className: 'dshMcpList' }, servers.slice(0, 8).map((server) => h('li', { key: server.name, className: 'dshMcpChip' }, server.name))),
      servers.length > 8 ? h('p', { className: 'dshMcpFoot' }, 'и ещё ' + (servers.length - 8) + ' — все на вкладке «Серверы и инструменты».') : null,
      h('div', { className: 'dshMcpBlockHead', style: { marginTop: '10px' } }, 'Модели: ' + models.length),
      models.length === 0
        ? h('p', { className: 'dshMcpFoot' }, probe.modelsError ? 'Список моделей не получен: ' + String(probe.modelsError) : 'Ключ не отдаёт ни одной модели.')
        : h('p', { className: 'dshMcpFoot' }, 'Перечень моделей — на вкладке «Серверы и инструменты».')),
    probe === null ? null : h('label', { className: 'dshMcpFieldLabel', htmlFor: 'dshMcpKeyLabel', style: { marginTop: '10px' } }, 'Название токена',
      h('input', {
        id: 'dshMcpKeyLabel',
        className: 'dshMcpInput',
        type: 'text',
        autoComplete: 'off',
        value: label,
        onChange: (event) => { labelTouched.current = true; setLabel(event.target.value) },
      })),
    probe === null ? null : h('label', { className: 'dshMcpCheck' },
      h('input', { type: 'checkbox', checked: activate, onChange: () => setActivate(!activate) }),
      h('span', null, 'Сделать активным сразу')),
    error === '' ? null : h(Notice, { text: error, tone: 'bad' })))
}

function DisconnectDialog(props) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    closeLabel: 'Закрыть',
    title: 'Отключить доступ?',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', onClick: props.onClose }, 'Отмена'),
      h(Button, {
        key: 'disconnect',
        variant: 'primary',
        disabled: saving,
        onClick: () => {
          setSaving(true)
          setError('')
          props.onDisconnect().then((payload) => {
            if (payload === null) setError('Не удалось: смотрите сообщение вверху экрана.')
            else props.onClose()
          }).finally(() => setSaving(false))
        },
      }, saving ? 'Отключаем…' : 'Отключить'),
    ],
  },
  h('div', { className: 'dshMcpModalBody' },
    h('p', { className: 'dshMcpModalText' }, 'Токен «' + (props.token === null ? '' : props.token.label) + '» перестанет действовать: MCP-серверы и модели у всех агентов этого DSH отключатся.'),
    h('p', { className: 'dshMcpFoot' }, 'Ключ остаётся сохранённым на этом DSH: доступ можно вернуть, подключив его снова, или заменить другим.'),
    error === '' ? null : h(Notice, { text: error, tone: 'bad' })))
}

function RemoveTokenDialog(props) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fromConfig = props.token.fromConfig !== false
  const lastToken = props.lastToken === true
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    closeLabel: 'Закрыть',
    title: fromConfig ? 'Скрыть токен?' : 'Удалить токен?',
    footer: [
      h(Button, { key: 'cancel', variant: 'outline', onClick: props.onClose }, 'Отмена'),
      h(Button, {
        key: 'remove',
        variant: 'primary',
        disabled: saving,
        onClick: () => {
          setSaving(true)
          setError('')
          props.onRemove(props.token.id).then((payload) => {
            if (payload === null) setError('Не удалось: смотрите сообщение вверху экрана.')
            else props.onClose()
          }).finally(() => setSaving(false))
        },
      }, saving ? 'Убираем…' : (fromConfig ? 'Скрыть токен' : 'Удалить токен')),
    ],
  },
  h('div', { className: 'dshMcpModalBody' },
    h('p', { className: 'dshMcpModalText' }, 'Токен «' + props.token.label + '» (' + props.token.id + ')'),
    fromConfig
      ? h('p', { className: 'dshMcpModalText' }, 'Этот токен описан в конфигурации плагина. Экран его скроет, гранты и ключ перестанут применяться, но запись в конфиге останется: вернуть можно кнопкой «Вернуть» на этом же экране.')
      : h('p', { className: 'dshMcpModalText' }, 'Токен создан здесь и будет удалён вместе со своим ключом LiteLLM. Отменить это нельзя.'),
    lastToken
      ? h('p', { className: 'dshMcpModalText' }, 'Это последний токен: доступ всех агентов к MCP-серверам и моделям выключится. Вернуть доступ можно, подключив ключ заново.')
      : (props.token.active === true
          ? h('p', { className: 'dshMcpFoot' }, 'Активный токен удалить нельзя: сначала примените другой токен.')
          : null),
    error === '' ? null : h(Notice, { text: error, tone: 'bad' })))
}

function SsoDialog(props) {
  return h(Modal, {
    open: true,
    onClose: props.onClose,
    closeLabel: 'Закрыть',
    title: 'Вход через SSO',
    footer: [
      h(Button, { key: 'close', variant: 'outline', onClick: props.onClose }, 'Закрыть'),
      h(Button, { key: 'token', variant: 'primary', onClick: props.onUseToken }, 'Подключить по ключу'),
    ],
  },
  h('div', { className: 'dshMcpModalBody' },
    h('p', { className: 'dshMcpModalText' }, 'Второго способа доступа пока нет: SSO — заглушка, к провайдеру не ведёт и ключ не выдаёт.'),
    h('p', { className: 'dshMcpModalText' }, 'Когда SSO появится, он станет вторым вариантом подключения: либо ключ LiteLLM, либо вход. Сейчас работает ключ.')))
}

/** Деньги из ответа шлюза: LiteLLM отдаёт доллары числом, null — лимит не задан. */
function moneyOf(value) {
  return typeof value === 'number' && Number.isFinite(value) ? '$' + value.toFixed(2) : '—'
}

/** Остаток по лимиту: null, когда лимита нет или расход неизвестен. */
function leftOf(spend, maxBudget) {
  if (typeof spend !== 'number' || typeof maxBudget !== 'number') return null
  return Math.max(0, maxBudget - spend)
}

/** Дата сброса окна бюджета в местном времени: «02.11.2026, 03:00». */
function resetOf(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const pad = (value) => String(value).padStart(2, '0')
  return pad(at.getDate()) + '.' + pad(at.getMonth() + 1) + '.' + at.getFullYear()
    + ', ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/** Тон полосы расхода: до 70% — обычный, до 90% — жёлтый, дальше красный. */
function spendTone(spend, maxBudget) {
  if (typeof spend !== 'number' || typeof maxBudget !== 'number' || maxBudget <= 0) return ''
  const ratio = spend / maxBudget
  if (ratio >= 0.9) return 'bad'
  if (ratio >= 0.7) return 'warn'
  return ''
}

/**
 * Загрузчик денег: тянет /api/budget отдельно от /api/state, чтобы статистика не держала
 * остальной экран. Пока ответа нет — status 'loading'; ошибка сети — status 'error' (данные,
 * если они уже были, сохраняются).
 * @param {{initial?: object|null, live?: boolean}} options - кеш из состояния и режим опроса.
 * @returns {{data: object|null, status: string}} данные и состояние загрузки.
 */
function useBudgetFeed(options) {
  const settings = options !== null && options !== undefined ? options : {}
  const initial = settings.initial !== null && settings.initial !== undefined ? settings.initial : null
  const live = settings.live === true
  const [data, setData] = useState(initial)
  const [status, setStatus] = useState(initial === null ? 'loading' : 'ready')
  useEffect(() => {
    let disposed = false
    let timer
    const load = () => {
      callApi('GET', '/budget').then((payload) => {
        if (disposed) return
        setData(payload)
        setStatus('ready')
      }).catch(() => {
        if (!disposed) setStatus('error')
      })
    }
    // Расход во шлюзе флашится раз в ~10 с, а лимит меняется ещё медленнее: минуты хватает.
    const schedule = () => {
      window.clearTimeout(timer)
      if (disposed) return
      timer = window.setTimeout(() => {
        if (!document.hidden) load()
        schedule()
      }, 60000)
    }
    load()
    if (live) schedule()
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [live])
  return { data, status }
}

/**
 * Бюджет активного ключа: расход и лимиты из /key/info и /user/info шлюза.
 * Данные тянет сам (/api/budget): в состоянии экрана лежит только кеш, чтобы /api/state
 * не ждал статистику.
 * @param {{initial: object|null|undefined}} props - кеш бюджета из /api/state.
 * @returns {object} карточка.
 */
function BudgetCard(props) {
  const [expandModels, setExpandModels] = useState(false)
  const [activeDay, setActiveDay] = useState('')
  // live: карточка тоже обновляется сама — иначе открытая вкладка «замерзает» на цифрах
  // момента открытия и выглядит как «бюджет не тратится».
  const feed = useBudgetFeed({ initial: props.initial, live: true })
  if (feed.status === 'loading' && feed.data === null) {
    return h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Деньги: сколько осталось'),
          h('p', { className: 'dshMcpCardNote' }, 'Считаем статистику шлюза — остальные настройки уже доступны.'))),
      h('p', { className: 'dshMcpFoot' }, 'Загружаем расход и лимит ключа из шлюза…'))
  }
  const budget = feed.data !== null ? feed.data : {}
  const key = budget.key !== null && budget.key !== undefined ? budget.key : null
  const user = budget.user !== null && budget.user !== undefined ? budget.user : null
  const team = budget.team !== null && budget.team !== undefined ? budget.team : null
  const today = budget.today !== null && budget.today !== undefined ? budget.today : null
  const week = budget.week !== null && budget.week !== undefined ? budget.week : null
  const error = String(budget.error || '')
  if (key === null && user === null) {
    return h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Бюджет ключа'),
          h('p', { className: 'dshMcpCardNote' }, 'Сколько денег осталось у ключа в шлюзе LiteLLM.'))),
      h(Notice, { text: error === '' ? 'Шлюз не рассказал о расходе ключа.' : 'Шлюз не отвечает: ' + error, tone: 'warn' }))
  }
  const ownerLimit = user === null ? null : user.maxBudget
  const ownerSpend = user === null ? null : user.spend
  const ownerLeft = leftOf(ownerSpend, ownerLimit)
  const ownerRatio = ownerLimit !== null && ownerLimit > 0 && ownerSpend !== null ? Math.min(100, Math.round((ownerSpend / ownerLimit) * 100)) : 0
  const ownerTone = spendTone(ownerSpend, ownerLimit)
  const ownerWindow = user === null || user.budgetDuration === '' ? '' : ' за ' + user.budgetDuration
  const resetAt = user === null ? '' : resetOf(user.resetAt)
  const weekDays = week !== null && Array.isArray(week.days) ? week.days : []
  // Выбранный день: пустое значение — сегодня. Нет недели — падаем на блок today из того же ответа.
  const fallbackDay = today === null
    ? null
    : { day: today.day, spend: today.spend, models: today.models, modelsTotal: today.modelsTotal }
  const selectedDay = activeDay === ''
    ? (weekDays.length > 0 ? weekDays[weekDays.length - 1] : fallbackDay)
    : (weekDays.find((entry) => entry.day === activeDay) || fallbackDay)
  const models = selectedDay === null || !Array.isArray(selectedDay.models) ? [] : selectedDay.models
  const modelsTotal = selectedDay !== null && typeof selectedDay.modelsTotal === 'number'
    ? selectedDay.modelsTotal
    : models.length
  const shownModels = expandModels ? models : models.slice(0, 6)
  const hiddenModels = Math.max(0, modelsTotal - shownModels.length)
  const dayTop = models.length > 0 ? Math.max(models[0].spend, 0.000001) : 1
  // Клик по последнему столбику — это снова «сегодня», а не «модели за дату».
  const isTodaySelected = selectedDay !== null
    && (weekDays.length > 0 ? selectedDay.day === weekDays[weekDays.length - 1].day : true)
  const weekValues = weekDays.map((entry) => (entry.spend === null ? 0 : entry.spend))
  const weekTop = weekValues.length > 0 ? Math.max.apply(null, weekValues.concat([0.000001])) : 1
  const tile = (label, value, title) => h('div', { className: 'dshMoneyTile' },
    h('span', { className: 'dshMoneyTileLabel' }, label),
    h('span', { className: 'dshMoneyTileValue', title: title === undefined ? value : title }, value))
  return h('div', { className: 'dshMcpCard' },
    h('div', { className: 'dshMcpCardHead' },
      h('div', null,
        h('h3', { className: 'dshMcpCardTitle' }, 'Деньги: сколько осталось'),
        h('p', { className: 'dshMcpCardNote' }, 'Считает шлюз LiteLLM. Лимит стоит на аккаунте, а не на этом DSH: его делят все ключи аккаунта.'))),
    h('div', { className: 'dshMoneyHero' },
      h('div', { className: 'dshMoneyHeroTop' },
        h('div', null,
          h('div', { className: 'dshMoneyLabel' }, ownerLimit === null ? 'Потрачено' : 'Осталось'),
          h('div', { className: 'dshMoneyValue' }, moneyOf(ownerLimit === null ? ownerSpend : ownerLeft)),
          h('div', { className: 'dshMoneySub' }, ownerLimit === null
            ? 'лимита у аккаунта нет'
            : 'из ' + moneyOf(ownerLimit) + ownerWindow + (resetAt === '' ? '' : ' · сброс ' + resetAt))),
        h('div', { className: 'dshMoneyRight' },
          h('div', { className: 'dshMoneyLabel' }, 'Израсходовано'),
          h('div', { className: 'dshMoneySpent' }, moneyOf(ownerSpend)),
          ownerLimit === null ? null : h('div', { className: 'dshMoneySub' }, String(ownerRatio) + '% лимита'))),
      ownerLimit === null ? null : h('div', { className: 'dshMcpBar dshMoneyBar' },
        h('div', {
          className: 'dshMcpBarFill' + (ownerTone === '' ? '' : ' dshMcpBarFill--' + ownerTone),
          style: { width: String(ownerRatio) + '%' },
        }))),
    h('div', { className: 'dshMoneyTiles' },
      tile('Лимит', ownerLimit === null ? 'не задан' : moneyOf(ownerLimit) + ownerWindow),
      tile('Сброс окна', resetAt === '' ? '—' : resetAt, user === null ? '' : user.resetAt),
      tile('Сегодня', today === null ? '—' : moneyOf(today.spend)),
      tile('За 7 дней', week === null ? '—' : moneyOf(week.total)),
      key === null ? null : tile('Ключ «' + (key.alias !== '' ? key.alias : key.name) + '»',
        moneyOf(key.spend) + ' за всё время',
        key.maxBudget === null ? 'лимита на ключе нет' : 'лимит ключа ' + moneyOf(key.maxBudget)),
      team === null ? null : tile('Группа' + (team.adfsGroup !== '' ? ' (ADFS)' : ''),
        (team.alias !== '' ? team.alias : team.id) + (team.members > 0 ? ' · ' + String(team.members) + ' чел.' : ''),
        'расход группы ' + moneyOf(team.spend) + (team.maxBudget === null ? ', лимита нет' : ', лимит ' + moneyOf(team.maxBudget)))),
    weekDays.length === 0 ? null : h('div', { className: 'dshMoneySection' },
      h('div', { className: 'dshMoneySectionHead' },
        h('span', null, 'Расход по дням'),
        h('span', { className: 'dshMoneySectionMeta' }, 'за неделю ' + moneyOf(week.total))),
      h('p', { className: 'dshMcpFoot' }, 'Сутки — в UTC, как их считает шлюз LiteLLM; обновление раз в минуту.'),
      h('div', { className: 'dshMoneyDays' }, weekDays.map((entry) => {
        const isActive = selectedDay !== null && selectedDay.day === entry.day
        return h('button', {
          type: 'button',
          className: 'dshMoneyDay' + (isActive ? ' dshMoneyDay--active' : ''),
          key: entry.day,
          title: entry.day + ': ' + (entry.spend === null ? 'нет данных' : moneyOf(entry.spend)),
          'aria-pressed': isActive,
          onClick: () => {
            setActiveDay(entry.day)
            setExpandModels(false)
          },
        },
        h('div', {
          className: 'dshMoneyDayBar' + (entry.spend === null || entry.spend <= 0 ? ' dshMoneyDayBar--muted' : ''),
          style: { height: String(Math.max(2, Math.round(((entry.spend === null ? 0 : entry.spend) / weekTop) * 100))) + '%' },
        }),
        h('div', { className: 'dshMoneyDayLabel' }, shortDay(entry.day)))
      }))),
    h('div', { className: 'dshMoneySection' },
      h('div', { className: 'dshMoneySectionHead' },
        h('span', null, isTodaySelected || selectedDay === null
          ? 'Сегодня по моделям'
          : 'Модели за ' + shortDay(selectedDay.day)),
        h('span', { className: 'dshMoneySectionMeta' },
          selectedDay === null ? '' : moneyOf(selectedDay.spend) + (modelsTotal > 0 ? ' · моделей ' + String(modelsTotal) : ''))),
      selectedDay === null || models.length === 0
        ? h('p', { className: 'dshMcpFoot' }, isTodaySelected || selectedDay === null
          ? 'Сегодня расхода ещё не было.'
          : 'В этот день расхода не было.')
        : h('div', { className: 'dshMoneyTable' },
          shownModels.map((entry) => h('div', { className: 'dshMoneyRow', key: entry.model },
            h('span', { className: 'dshMoneyRowName', title: entry.model }, shortModel(entry.model)),
            h('span', { className: 'dshMoneyRowShare' },
              h('span', {
                className: 'dshMoneyRowShareFill',
                style: { width: String(Math.max(2, Math.round((entry.spend / dayTop) * 100))) + '%' },
              })),
            h('span', { className: 'dshMoneyRowValue' }, moneyOf(entry.spend)))),
          hiddenModels > 0 || expandModels
            ? h('button', {
              type: 'button',
              className: 'dshMoneyToggle',
              onClick: () => setExpandModels(!expandModels),
            }, expandModels ? 'свернуть' : 'показать все (' + String(modelsTotal) + ')')
            : null)),
    error === '' ? null : h(Notice, { text: 'Часть ответа шлюза недоступна: ' + error, tone: 'warn' }),
    h('p', { className: 'dshMcpFoot' },
      'Источники: /key/info, /user/info, /team/info, /spend/logs шлюза. Расход обновляется с задержкой ~10 с; '
      + 'для моделей без тарифа в шлюзе сумма занижена.'
      + (typeof budget.fetchedAt === 'number' ? ' Данные на ' + new Date(budget.fetchedAt).toLocaleTimeString('ru-RU') + '.' : '')))
}
/**
 * Чип бюджета под композером: «$4.44 / $10.00» и полоска расхода; подробности — по наведению.
 * Данные тянет сам (маршрут /api/budget), потому что слот композера не получает state экрана.
 * @returns {object|null} чип либо null, когда шлюз молчит или лимита нет.
 */
function BudgetChip() {
  const [open, setOpen] = useState(false)
  const feed = useBudgetFeed({ live: true })
  const data = feed.data
  if (feed.status === 'error' || data === null || data === undefined) return null
  const user = data.user !== null && data.user !== undefined ? data.user : null
  const key = data.key !== null && data.key !== undefined ? data.key : null
  const team = data.team !== null && data.team !== undefined ? data.team : null
  const today = data.today !== null && data.today !== undefined ? data.today : null
  if (user === null && key === null) return null
  const limit = user === null ? null : user.maxBudget
  const spent = user === null ? null : user.spend
  const left = leftOf(spent, limit)
  const ratio = limit !== null && limit > 0 && spent !== null ? Math.min(100, Math.round((spent / limit) * 100)) : 0
  const tone = spendTone(spent, limit)
  const summary = limit === null
    ? 'Потрачено ' + moneyOf(spent) + ', лимита у аккаунта нет'
    : 'Потрачено ' + moneyOf(spent) + ' из ' + moneyOf(limit) + ', осталось ' + moneyOf(left)
  const tip = open
    ? h('span', { className: 'dshBudgetTip', role: 'tooltip' },
      h('span', { className: 'dshBudgetTipHead' }, limit === null
        ? 'Бюджет аккаунта: лимита нет'
        : 'Осталось ' + moneyOf(left) + ' из ' + moneyOf(limit)),
      h('span', { className: 'dshBudgetTipRow' },
        h('span', null, 'Израсходовано' + (user !== null && user.budgetDuration !== '' ? ' за ' + user.budgetDuration : '')),
        h('span', { className: 'dshBudgetTipValue' }, moneyOf(spent))),
      user === null || user.resetAt === '' ? null : h('span', { className: 'dshBudgetTipRow' },
        h('span', null, 'Сброс окна'),
        h('span', { className: 'dshBudgetTipValue' }, resetOf(user.resetAt))),
      today === null ? null : h('span', { className: 'dshBudgetTipRow' },
        h('span', null, 'Сегодня'),
        h('span', { className: 'dshBudgetTipValue' }, moneyOf(today.spend))),
      team === null ? null : h('span', { className: 'dshBudgetTipRow' },
        h('span', null, 'Группа' + (team.adfsGroup !== '' ? ' (ADFS)' : '')),
        h('span', { className: 'dshBudgetTipValue', title: team.alias },
          (team.alias !== '' ? team.alias : '—') + (team.members > 0 ? ' · ' + String(team.members) + ' чел.' : ''))),
      h('span', { className: 'dshBudgetTipFoot' },
        'Разбивка по моделям и расход ключа — в настройках: verme-gate → Доступ. Лимит общий на аккаунт.'))
    : null
  return h('span', {
    className: 'dshBudgetChip',
    role: 'status',
    tabIndex: 0,
    'aria-label': summary,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
  },
  h('span', null, limit === null ? moneyOf(spent) : moneyOf(spent) + ' / ' + moneyOf(limit)),
  h('span', { className: 'dshBudgetChipTrack' },
    h('span', {
      className: 'dshBudgetChipFill' + (tone === '' ? '' : ' dshBudgetChipFill--' + tone),
      style: { width: String(ratio) + '%' },
    })),
  tip)
}


/**
 * Загрузчик проверки обновлений: /api/update отдельным запросом — это единственный поход плагина
 * в интернет (GitHub), и настройки не должны его ждать. Сервер кеширует ответ на updateCheckMs.
 * @param {{initial?: object|null, live?: boolean}} options - кеш из состояния и режим опроса.
 * @returns {object|null} блок update либо null, пока не ответили.
 */
function useUpdateFeed(options) {
  const settings = options !== null && options !== undefined ? options : {}
  const initial = settings.initial !== null && settings.initial !== undefined ? settings.initial : null
  const live = settings.live === true
  const [data, setData] = useState(initial)
  useEffect(() => {
    let disposed = false
    let timer
    const load = () => {
      callApi('GET', '/update').then((payload) => {
        if (!disposed) setData(payload)
      }).catch(() => {
        /* молчание GitHub — не повод ломать чип: подробности в карточке настроек */
      })
    }
    // Суточный кеш на хосте: чаще спрашивать бессмысленно, шести часов хватает.
    const schedule = () => {
      window.clearTimeout(timer)
      if (disposed) return
      timer = window.setTimeout(() => {
        if (!document.hidden) load()
        schedule()
      }, 6 * 60 * 60 * 1000)
    }
    load()
    if (live) schedule()
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [live])
  return data
}

/**
 * Есть ли что сообщать про обновление: новая версия плагина и/или DSH вне проверенного диапазона.
 * @param {object|null} data - блок update из /api/update.
 * @returns {{available: boolean, dshBad: boolean, latest: string, version: string, dsh: object|null}|null} проблема.
 */
function updateProblemOf(data) {
  if (data === null || data === undefined) return null
  const available = data.available === true
  const dsh = data.dsh !== null && data.dsh !== undefined ? data.dsh : null
  const dshBad = dsh !== null && dsh.known === true && dsh.ok === false
  if (!available && !dshBad) return null
  return {
    available,
    dshBad,
    latest: String(data.latest || ''),
    version: String(data.version || ''),
    dsh,
  }
}

/**
 * Положить текст в буфер обмена (кнопка «копировать»). Не умеет — молча false.
 * @param {string} text - что копировать.
 * @returns {Promise<boolean>} получилось ли.
 */
function copyText(text) {
  if (typeof text !== 'string' || text === '') return Promise.resolve(false)
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return Promise.resolve(false)
  if (typeof navigator.clipboard.writeText !== 'function') return Promise.resolve(false)
  return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
}

/**
 * Чип обновления в доке композера, рядом с бюджетом: появляется только когда есть о чём сказать
 * (новая версия или несовместимая сборка DSH). По наведению — команда обновления и совместимость.
 * @returns {object|null} чип либо null, когда всё в порядке.
 */
function UpdateChip() {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const data = useUpdateFeed({ live: true })
  const problem = updateProblemOf(data)
  if (problem === null) return null
  const dsh = problem.dsh
  const dshVersion = dsh !== null && dsh.version !== '' ? String(dsh.version) : 'версия неизвестна'
  const range = dsh !== null && dsh.range !== undefined ? String(dsh.range) : ''
  const tested = Array.isArray(data.testedDsh) ? data.testedDsh : []
  const command = String(data.installCommand || '')
  const head = problem.available
    ? 'Доступна версия ' + problem.latest + ' (у вас ' + problem.version + ')'
    : 'DSH ' + dshVersion + ' вне проверенного диапазона'
  const tip = open
    ? h('span', { className: 'dshUpdateTip', role: 'tooltip' },
      h('span', { className: 'dshUpdateTipHead' }, head),
      problem.available
        ? h('span', null, 'Обновление — поставить тег и перезапустить DSH (host-половина живёт до рестарта).')
        : null,
      problem.available && command !== '' ? h('code', { className: 'dshUpdateCmd' }, command) : null,
      problem.available ? h('code', { className: 'dshUpdateCmd' }, 'systemctl --user restart <unit>') : null,
      problem.available
        ? h('span', { className: 'dshUpdateRow' },
          h('a', {
            className: 'dshUpdateLink',
            href: String(data.tagsUrl || ''),
            target: '_blank',
            rel: 'noreferrer',
          }, 'Что изменилось →'),
          h('a', {
            className: 'dshUpdateLink',
            href: '#',
            onClick: (event) => {
              event.preventDefault()
              copyText(command).then((ok) => setCopied(ok))
            },
          }, copied ? 'команда скопирована' : 'копировать команду'))
        : null,
      h('span', { className: 'dshUpdateRow' },
        h('span', null, 'Работает на DSH'),
        h('span', { className: 'dshUpdateValue' }, dshVersion + (dsh !== null && dsh.known === true && dsh.ok === true ? ' · ок' : ''))),
      h('span', { className: 'dshUpdateRow' },
        h('span', null, 'Объявлено'),
        h('span', { className: 'dshUpdateValue' }, range === '' ? '—' : range)),
      h('span', { className: 'dshUpdateRow' },
        h('span', null, 'Проверено на'),
        h('span', { className: 'dshUpdateValue' }, tested.length === 0 ? '—' : tested.join(', '))),
      problem.dshBad
        ? h('span', null, 'Эта сборка DSH не проверялась: возможны сбои гейта и монтирования. Поставьте DSH из проверенной линии или обновите плагин.')
        : null,
      h('span', { className: 'dshMcpFoot' }, 'Подробнее — verme-gate → Доступ → «Обновление плагина».')
    )
    : null
  return h('span', {
    className: 'dshUpdateChip' + (problem.available ? '' : ' dshUpdateChip--warn'),
    role: 'status',
    tabIndex: 0,
    'aria-label': head,
    onMouseEnter: () => setOpen(true),
    onMouseLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onClick: () => setOpen(!open),
  },
  h('span', { className: 'dshUpdateDot' }),
  h('span', null, problem.available ? 'обновление v' + problem.latest : 'DSH ' + dshVersion + ' не проверен'),
  tip)
}

/**
 * Карточка «Обновление плагина» в экране настроек: что установлено, что вышло, какие команды
 * и какой диапазон DSH поддерживается (объявленный и проверенный). Свежая проверка — по кнопке.
 * @returns {object} карточка.
 */
function UpdateCard() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const load = (force) => callApi('GET', force ? '/update?force=1' : '/update')
  useEffect(() => {
    let disposed = false
    load(false).then((payload) => {
      if (!disposed) setData(payload)
    }).catch(() => {})
    return () => {
      disposed = true
    }
  }, [])
  const check = () => {
    setBusy(true)
    load(true).then((payload) => setData(payload)).catch(() => {}).then(() => setBusy(false))
  }
  const loaded = data !== null && data !== undefined
  const version = loaded ? String(data.version || '') : ''
  const latest = loaded ? String(data.latest || '') : ''
  const available = loaded && data.available === true
  const error = loaded ? String(data.error || '') : ''
  const dsh = loaded && data.dsh !== null && data.dsh !== undefined ? data.dsh : null
  const tested = loaded && Array.isArray(data.testedDsh) ? data.testedDsh : []
  const testedNote = loaded ? String(data.testedNote || '') : ''
  const command = loaded ? String(data.installCommand || '') : ''
  const rollback = loaded ? String(data.rollbackCommand || '') : ''
  const checkedAt = loaded && typeof data.fetchedAt === 'number'
    ? new Date(data.fetchedAt).toLocaleString('ru-RU')
    : ''
  const dshVersion = dsh !== null && dsh.version !== '' ? String(dsh.version) : 'неизвестна'
  const dshBad = dsh !== null && dsh.known === true && dsh.ok === false
  const copyCommand = (text) => copyText(text).then((ok) => setCopied(ok ? text : ''))
  return h('div', { className: 'dshMcpCard' },
    h('div', { className: 'dshMcpCardHead' },
      h('div', null,
        h('h3', { className: 'dshMcpCardTitle' }, 'Обновление плагина'),
        h('p', { className: 'dshMcpCardNote' }, 'DSH не обновляет плагины сам: версия ставится командой и подхватывается рестартом.')),
      h(Button, { variant: 'outline', onClick: check, disabled: busy }, busy ? 'Проверяем…' : 'Проверить')),
    h('div', { className: 'dshMoneyTiles' },
      h('div', { className: 'dshMoneyTile' },
        h('span', { className: 'dshMoneyTileLabel' }, 'Установлено'),
        h('span', { className: 'dshMoneyTileValue' }, version === '' ? '—' : 'v' + version)),
      h('div', { className: 'dshMoneyTile' },
        h('span', { className: 'dshMoneyTileLabel' }, 'Последняя'),
        h('span', { className: 'dshMoneyTileValue' }, latest === '' ? '—' : 'v' + latest)),
      h('div', { className: 'dshMoneyTile' },
        h('span', { className: 'dshMoneyTileLabel' }, 'Проверено'),
        h('span', { className: 'dshMoneyTileValue' }, checkedAt === '' ? 'ещё не проверяли' : checkedAt))),
    available
      ? h('div', { className: 'dshMcpStack' },
        h(Notice, { text: 'Вышла версия ' + latest + ' (у вас ' + version + ').', tone: 'info' }),
        h('p', { className: 'dshMcpFoot' }, 'Поставить тег и перезапустить DSH:'),
        h('code', { className: 'dshUpdateCmd' }, command),
        h('code', { className: 'dshUpdateCmd' }, 'systemctl --user restart <unit>'),
        h('div', { className: 'dshMcpActions' },
          h(Button, { variant: 'outline', onClick: () => copyCommand(command) }, copied === command ? 'скопировано' : 'копировать команду'),
          h('a', { className: 'dshUpdateLink', href: String(data.tagsUrl || ''), target: '_blank', rel: 'noreferrer' }, 'Список версий →')),
        rollback === '' ? null : h('p', { className: 'dshMcpFoot' }, 'Откат на текущую: ', h('code', null, rollback)))
      : null,
    loaded && !available && error === ''
      ? h('p', { className: 'dshMcpFoot' }, 'Обновлений нет: установлена последняя версия.')
      : null,
    error !== '' ? h(Notice, { text: 'Не смогли узнать версию: ' + error, tone: 'warn' }) : null,
    h('div', { className: 'dshMcpRow', style: { marginTop: '12px' } },
      h('div', { className: 'dshMcpRowMain' },
        h('span', { className: 'dshMcpRowTitle' }, 'Совместимость с DSH'),
        h('span', { className: 'dshMcpRowMeta' },
          'сейчас ' + dshVersion
          + (dsh !== null && dsh.range !== undefined && dsh.range !== '' ? ' · объявлено ' + String(dsh.range) : '')
          + (tested.length > 0 ? ' · проверено на ' + tested.join(', ') : '')))),
    testedNote === '' ? null : h('p', { className: 'dshMcpFoot' }, 'Глубина прогонов: ' + testedNote + '.'),
    dshBad
      ? h(Notice, { text: 'Эта сборка DSH не проверялась (плагин собран под ' + String(dsh.range || '') + '): возможны сбои гейта и монтирования.', tone: 'warn' })
      : null,
    h('p', { className: 'dshMcpFoot' },
      'Проверка ходит в GitHub за тегами репозитория ', h('code', null, String(loaded ? data.repo : '')),
      '; ответ кешируется на сутки (updateCheckMs), сеть можно выключить (updateCheck: false).'))
}

function AccessTab(props) {
  const data = props.data
  const tokens = Array.isArray(data.tokens) ? data.tokens : []
  const activeToken = tokens.find((token) => token.id === data.activeToken) || null
  const hiddenTokens = Array.isArray(data.hiddenTokens) ? data.hiddenTokens : []
  const models = data.models !== null && data.models !== undefined && Array.isArray(data.models.allowed) ? data.models.allowed : null
  const mountedCount = (Array.isArray(data.servers) ? data.servers : []).filter((server) => server.status === 'mounted').length
  const [dialog, setDialog] = useState(null)
  const phase = PHASES[data.phase] || { label: String(data.phase || 'неизвестно'), tone: 'idle' }
  const connected = activeToken !== null
  let note = ''
  if (!connected) {
    note = 'Доступ выдаётся одним из двух способов: ключ LiteLLM или вход через SSO. Пока не подключено ни то ни другое — MCP-серверы и модели недоступны.'
  } else if (data.lastError !== '' && data.lastError !== undefined && data.lastError !== null) {
    note = 'Последняя ошибка: ' + String(data.lastError)
  } else if (Number(data.applyPending) > 0 || data.barrier === true) {
    note = 'Подключение ещё идёт: серверы и инструменты появятся сами.'
  }
  // Возвращаем все скрытые токены, а не первый: иначе кнопка врёт о количестве.
  const restoreAll = () => {
    let chain = Promise.resolve(null)
    hiddenTokens.forEach((token) => {
      chain = chain.then(() => props.onRestoreToken(token.id))
    })
    return chain
  }
  const replaceKey = (payload) => {
    if (activeToken !== null && activeToken.keyWritable === true) {
      return props.onSaveTokenKey(activeToken.id, payload.key)
    }
    return props.onConnectToken(payload)
  }
  return h('div', { className: 'dshMcpStack' },
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Подключение'),
          h('p', { className: 'dshMcpCardNote' }, connected
            ? 'Ключ определяет, какие MCP-серверы и модели видит этот DSH. Подключён один способ доступа.'
            : 'Один способ доступа: ключ LiteLLM или SSO.')),
        pill(connected ? phase.label : 'Не подключено', connected ? phase.tone : 'idle')),
      note === '' ? null : h(Notice, { text: note, tone: phase.tone === 'bad' ? 'bad' : 'warn' }),
      connected
        ? h('div', { className: 'dshMcpRow' },
          h('div', { className: 'dshMcpRowMain' },
            h('span', { className: 'dshMcpRowTitle' }, activeToken.label),
            h('span', { className: 'dshMcpRowMeta' },
              'серверов подключено: ' + String(mountedCount)
              + ' · моделей: ' + (models === null ? 'права неизвестны' : String(models.length))
              + (activeToken.keyConfigured === true ? '' : ' · ключ не задан'))))
        : h('div', { className: 'dshMcpEmpty' }, 'Способ доступа не выбран.'),
      h('div', { className: 'dshMcpActions', style: { marginTop: '12px' } },
        connected
          ? h(Button, { variant: 'primary', onClick: () => setDialog({ kind: 'replace' }) }, 'Заменить ключ')
          : h(Button, { variant: 'primary', onClick: () => setDialog({ kind: 'connect' }) }, 'Подключить по ключу'),
        connected
          ? h(Button, { variant: 'outline', onClick: () => setDialog({ kind: 'disconnect' }) }, 'Отключить')
          : h(Button, { variant: 'outline', onClick: () => setDialog({ kind: 'sso' }) }, 'Войти через SSO')),
      connected
        ? h('p', { className: 'dshMcpFoot' }, '«Отключить» снимает доступ, ключ при этом остаётся на этом DSH. ',
          h('a', {
            href: '#',
            onClick: (event) => { event.preventDefault(); props.onOpenServers() },
            style: { color: 'var(--dsw-alias-state-business-primary, #4176e6)' },
          }, 'Серверы и инструменты →'))
        : h('p', { className: 'dshMcpFoot' }, 'SSO пока заглушка: провайдера входа ещё нет, доступ выдаётся ключом LiteLLM.'),
      hiddenTokens.length === 0
        ? null
        : h('p', { className: 'dshMcpFoot' },
          h('span', null, 'Скрытые: ' + hiddenTokens.map((token) => token.label).join(', ') + ' '),
          h(Button, { variant: 'outline', onClick: restoreAll }, 'Вернуть'))),
    h(BudgetCard, { initial: data.budget }),
    h(UpdateCard, null),
    dialog !== null && dialog.kind === 'connect'
      ? h(ConnectKeyDialog, {
        onClose: () => setDialog(null),
        onConnect: (payload) => props.onConnectToken(payload).then((result) => {
          if (result !== null) setDialog(null)
          return result
        }),
      })
      : null,
    dialog !== null && dialog.kind === 'replace'
      ? h(ConnectKeyDialog, {
        mode: 'replace',
        onClose: () => setDialog(null),
        onConnect: (payload) => replaceKey(payload).then((result) => {
          if (result !== null) setDialog(null)
          return result
        }),
      })
      : null,
    dialog !== null && dialog.kind === 'disconnect'
      ? h(DisconnectDialog, { token: activeToken, onClose: () => setDialog(null), onDisconnect: props.onDisconnect })
      : null,
    dialog !== null && dialog.kind === 'sso'
      ? h(SsoDialog, { onClose: () => setDialog(null), onUseToken: () => { setDialog(null); setDialog({ kind: 'connect' }) } })
      : null)
}

function ServersTab(props) {
  const data = props.data
  const tokens = Array.isArray(data.tokens) ? data.tokens : []
  const activeToken = tokens.find((token) => token.id === data.activeToken) || null
  const servers = Array.isArray(data.servers) ? data.servers : []
  const modelsInfo = data.models !== null && data.models !== undefined ? data.models : null
  const models = modelsInfo !== null && Array.isArray(modelsInfo.allowed) ? modelsInfo.allowed : null
  const modelKeyState = modelsInfo === null ? '' : String(modelsInfo.keyState || '')
  const modelKeyBad = modelKeyState !== '' && modelKeyState !== 'ok'
  const gateway = data.gateway !== null && data.gateway !== undefined ? data.gateway : {}
  const configOnly = Array.isArray(gateway.configOnlyServers) ? gateway.configOnlyServers : []
  const [expanded, setExpanded] = useState({})
  const [headersOpen, setHeadersOpen] = useState({})
  const [envOpen, setEnvOpen] = useState({})
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState(null)
  const tokenSeen = useRef(data.activeToken)
  // Смена активного токена — другой ключ: раскрытые панели и черновики к нему не относятся.
  useEffect(() => {
    if (tokenSeen.current === data.activeToken) return
    tokenSeen.current = data.activeToken
    setExpanded({})
    setHeadersOpen({})
    setEnvOpen({})
  }, [data.activeToken])
  if (activeToken === null) {
    return h('div', { className: 'dshMcpStack' },
      h('div', { className: 'dshMcpCard' },
        h('div', { className: 'dshMcpCardHead' },
          h('div', null,
            h('h3', { className: 'dshMcpCardTitle' }, 'Серверы и инструменты'),
            h('p', { className: 'dshMcpCardNote' }, 'Список появится после подключения: пока доступа нет, шлюз не сообщает, что и какие инструменты выданы.'))),
        h('div', { className: 'dshMcpEmpty' }, 'Подключения нет.'),
        h('div', { className: 'dshMcpActions', style: { marginTop: '12px' } },
          h(Button, { variant: 'primary', onClick: props.onOpenAccess }, 'Перейти к подключению'))))
  }
  const needle = filter.trim().toLowerCase()
  const visible = servers.filter((server) => {
    if (needle === '') return true
    return (String(server.label || '') + ' ' + String(server.name || '') + ' ' + String(server.description || '')).toLowerCase().indexOf(needle) !== -1
  })
  const rows = []
  visible.forEach((server) => {
    // Список приходит из реестра шлюза: всё, что здесь есть, ключу выдано. Требования сервер
    // объявляет сам (запись в шлюзе + user-env-vars), поэтому конфиг плагина их не задаёт.
    const state = serverStateOf(server)
    const allowed = allowedToolsOf(server)
    const obtained = obtainedToolsOf(server)
    const isOpen = expanded[server.name] === true
    const isHeadersOpen = headersOpen[server.name] === true
    const isEnvOpen = envOpen[server.name] === true
    const envItems = Array.isArray(server.envRequired) ? server.envRequired : []
    const headerItems = headerListOf(server)
    const chips = requirementChips(server)
    const toolsMeta = obtained.length === 0 ? '' : allowed.length + ' из ' + obtained.length
    // Вердикт проверки: одна метка на строку, подробности — в title. Если вердикт совпадает с
    // подписью статуса (token-rejected), второй раз его не печатаем.
    const verdict = verdictOf(server)
    const verdictLabel = verdict !== null && verdict.label !== state.label ? verdict : null
    const envMissing = Number(server.missingCount || 0) > 0
    const headerMissing = headerItems.some((item) => item.isSet !== true)
    const missingNames = []
    if (envMissing) {
      envItems.forEach((item) => { if (item.isSet !== true) missingNames.push(String(item.name || '')) })
    }
    if (headerMissing) {
      headerItems.forEach((item) => { if (item.isSet !== true) missingNames.push(item.name) })
    }
    const verifyBlocked = envMissing || headerMissing
    const verifyBlockedTitle = missingNames.length > 0
      ? 'сначала заполните: ' + missingNames.join(', ')
      : 'сначала заполните значения'
    const metaChildren = []
    const pushMeta = (node) => {
      if (metaChildren.length > 0) metaChildren.push(' · ')
      metaChildren.push(node)
    }
    // Если вердикт совпал со статусом, его подробности вешаем на сам статус — метку не дублируем.
    const statusTitle = verdict !== null && verdictLabel === null ? verdictHintOf(server) : undefined
    pushMeta(h('span', { key: 'status', title: statusTitle }, state.label))
    if (toolsMeta !== '') pushMeta(toolsMeta)
    if (verdictLabel !== null) {
      pushMeta(h('span', {
        key: 'verdict',
        className: 'dshMcpVerdict--' + verdictLabel.tone,
        title: verdictHintOf(server),
      }, verdictLabel.label))
    }
    const hasProbe = String(server.verifyTool || '') !== ''
    const verifying = props.busyKey === 'verify:' + server.name
    const envPanelId = panelIdOf('Env', server.name)
    const headersPanelId = panelIdOf('Headers', server.name)
    const toolsPanelId = panelIdOf('Tools', server.name)
    // Сырой текст отказа нужен только там, где он объясняет статус: остальное уже в подписи.
    const showError = String(server.error || '') !== ''
      && (server.status === 'failed' || server.status === 'token-rejected' || server.status === 'key-error')
    const block = [h('div', { className: 'dshMcpSrv' },
      h('div', { className: 'dshMcpSrvMain' },
        h('div', { className: 'dshMcpSrvLine' },
          h('span', { className: 'dshMcpDot dshMcpDot--' + state.tone }),
          h('span', { className: 'dshMcpServerTitle' }, server.label || server.name),
          h('span', { className: 'dshMcpRowMeta' }, metaChildren)),
        chips.length === 0
          ? null
          : h('div', { className: 'dshMcpChips' }, chips.map((chip) => h('code', {
            className: 'dshMcpChipCode',
            key: chip.name,
            title: chip.hint,
          }, chip.name))),
        server.description === '' ? null : h('span', { className: 'dshMcpDesc', title: server.description }, server.description),
        showError ? h('span', { className: 'dshMcpRowMeta' }, String(server.error)) : null),
      h('div', { className: 'dshMcpActions' },
        envItems.length === 0
          ? null
          : h(Button, {
            variant: envMissing ? 'primary' : 'outline',
            'aria-expanded': isEnvOpen,
            'aria-controls': isEnvOpen ? envPanelId : undefined,
            onClick: () => {
              const next = Object.assign({}, envOpen)
              next[server.name] = !isEnvOpen
              setEnvOpen(next)
            },
          }, 'Переменные'),
        headerItems.length === 0 && server.tokenHeader === ''
          ? null
          : h(Button, {
            variant: 'outline',
            'aria-expanded': isHeadersOpen,
            'aria-controls': isHeadersOpen ? headersPanelId : undefined,
            onClick: () => {
              const next = Object.assign({}, headersOpen)
              next[server.name] = !isHeadersOpen
              setHeadersOpen(next)
            },
          }, 'Заголовки'),
        hasProbe
          ? h(Button, {
            variant: 'outline',
            disabled: props.busy === true || verifyBlocked,
            title: verifyBlocked ? verifyBlockedTitle : '',
            onClick: () => props.onVerify(server.name),
          }, verifying ? 'Проверяем…' : 'Проверить')
          : null,
        h(Button, {
          variant: 'outline',
          'aria-expanded': isOpen,
          'aria-controls': isOpen ? toolsPanelId : undefined,
          onClick: () => {
            const next = Object.assign({}, expanded)
            next[server.name] = !isOpen
            setExpanded(next)
          },
        }, isOpen ? 'Скрыть инструменты' : 'Инструменты')))]
    if (isOpen) {
      block.push(h('div', { className: 'dshMcpSrvTools', id: toolsPanelId }, h(ToolsList, { server: server })))
    }
    if (isEnvOpen) {
      block.push(h('div', { className: 'dshMcpSrvTools', id: envPanelId },
        h(ServerEnvVars, {
          key: 'env-' + String(data.activeToken),
          server: server,
          busy: props.busy === true,
          onSaveEnvVar: props.onSaveEnvVar,
          onClearEnvVars: props.onClearEnvVars,
        })))
    }
    if (isHeadersOpen) {
      block.push(h('div', { className: 'dshMcpSrvTools', id: headersPanelId },
        h(ServerHeaders, {
          key: 'headers-' + String(data.activeToken),
          server: server,
          busy: props.busy === true,
          onSaveHeader: props.onSaveHeader,
        })))
    }
    rows.push(h('div', { className: 'dshMcpSrvBlock dshMcpSrvBlock--' + state.tone, key: server.name }, block))
  })
  return h('div', { className: 'dshMcpStack' },
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Серверы и инструменты'),
          h('p', { className: 'dshMcpCardNote' }, 'Что выдал шлюз этому ключу.')),
        servers.length === 0
          ? null
          : h('input', {
            className: 'dshMcpInput',
            style: { width: '180px', height: '32px' },
            type: 'search',
            placeholder: 'Найти сервер',
            'aria-label': 'Найти сервер',
            value: filter,
            onChange: (event) => setFilter(event.target.value),
          })),
      visible.length === 0
        ? h('div', { className: 'dshMcpEmpty' },
          servers.length > 0
            ? 'Ничего не найдено.'
            : (gateway.registryError !== undefined && gateway.registryError !== ''
                ? 'шлюз не ответил: ' + String(gateway.registryError)
                : 'шлюз не выдал серверов'))
        : h('div', { className: 'dshMcpSrvList' }, rows),
      h('p', { className: 'dshMcpFoot' }, 'Права — у ключа в шлюзе; «скрыт в DSH» — локальный запрет вызова.')),
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Модели'),
          h('p', { className: 'dshMcpCardNote' }, models === null
            ? 'Каталог ключа.'
            : 'Моделей: ' + models.length + '.')),
        modelsInfo !== null && modelsInfo.degraded === true ? pill('Каталог неполный', 'warn') : null),
      // Ключ не в порядке — каталог может быть пуст или неполон; причина в подсказке.
      modelKeyBad
        ? h(Notice, { text: 'ключ: ' + modelKeyState, tone: 'warn', title: String(modelsInfo.error || '') })
        : null,
      models === null
        ? h('div', { className: 'dshMcpEmpty' }, 'Каталог не получен — права неизвестны.')
        : models.length === 0
          ? h('div', { className: 'dshMcpEmpty' }, 'Моделей нет.')
          : models.length <= 6
            ? h('ul', { className: 'dshMcpList' }, models.map((model) => h('li', { key: model, className: 'dshMcpChip' }, model)))
            : h('details', { className: 'dshMcpDetails' },
              h('summary', null, 'Показать все ' + models.length + ' моделей'),
              h('ul', { className: 'dshMcpList dshMcpScroll' }, models.map((model) => h('li', { key: model, className: 'dshMcpChip' }, model)))),
      data.models !== null && data.models !== undefined && currentModelText(data.models.current) !== ''
        ? h('p', { className: 'dshMcpFoot' }, 'по умолчанию: ' + currentModelText(data.models.current))
        : null),
    configOnly.length === 0
      ? null
      : h('p', { className: 'dshMcpFoot' }, 'в конфиге, но не выданы ключу: ' + configOnly.join(', ')))
}

function ExtraTab(props) {
  const data = props.data
  const tokens = Array.isArray(data.tokens) ? data.tokens : []
  const [dialog, setDialog] = useState(null)
  const [diag, setDiag] = useState({ status: 'loading', data: null, error: '' })
  useEffect(() => {
    let alive = true
    callApi('GET', '/diag').then((payload) => {
      if (alive) setDiag({ status: 'ready', data: payload, error: '' })
    }).catch((error) => {
      if (alive) setDiag({ status: 'error', data: null, error: String(error.message || error) })
    })
    return () => { alive = false }
  }, [])
  const retry = data.retry || {}
  const agents = data.agentsReport || {}
  const gateway = data.gateway || {}
  const registered = Array.isArray(gateway.registeredServers) ? gateway.registeredServers : []
  // Авто-повтор описывается только тем, что есть в состоянии: попытки, время следующей, ошибка.
  const retryAttempts = Number(retry.attempts || 0)
  const retryLastError = String(retry.lastError || '')
  let retryText = 'не требуется'
  if (retryAttempts > 0) {
    retryText = 'попытка ' + String(retryAttempts)
    if (retry.nextRetryAt) {
      const at = Date.parse(String(retry.nextRetryAt))
      const ms = retry.retryInMs === null || retry.retryInMs === undefined
        ? (Number.isNaN(at) ? 0 : Math.max(0, at - Date.now()))
        : Number(retry.retryInMs)
      retryText += ' через ' + String(Math.max(0, Math.ceil(ms / 1000))) + ' с'
    }
  }
  // Ошибки шлюза и его предупреждения раньше не выводились вовсе.
  const gatewayWarnings = []
  if (String(gateway.keyHealthError || '') !== '') gatewayWarnings.push('ключ шлюза: ' + String(gateway.keyHealthError))
  if (String(gateway.envStatusError || '') !== '') gatewayWarnings.push('переменные шлюза: ' + String(gateway.envStatusError))
  if (String(gateway.registryError || '') !== '') gatewayWarnings.push('реестр шлюза: ' + String(gateway.registryError))
  const registryWarnings = Array.isArray(data.registryWarnings) ? data.registryWarnings : []
  registryWarnings.forEach((warning) => {
    if (warning !== null && warning !== undefined && String(warning) !== '') gatewayWarnings.push(String(warning))
  })
  return h('div', { className: 'dshMcpStack' },
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Состояние подключения'),
          h('p', { className: 'dshMcpCardNote' }, 'Служебные подробности плагина и повторное подключение серверов.'))),
      h('dl', { className: 'dshMcpKv' },
        h('dt', null, 'Фаза'), h('dd', null, String(data.phase || '—')),
        h('dt', null, 'Барьер применения'), h('dd', null, data.barrier === true ? 'поднят' : 'снят'),
        h('dt', null, 'Поколение настроек'), h('dd', null, String(data.generation === undefined ? '—' : data.generation)),
        h('dt', null, 'Агенты под гейтом'), h('dd', null, String(agents.gated === undefined ? '—' : agents.gated) + ' из ' + String(agents.candidates === undefined ? '—' : agents.candidates)),
        h('dt', null, 'Шлюз'), h('dd', null, String(gateway.baseUrl || '—')),
        h('dt', null, 'Серверы в реестре шлюза'), h('dd', null, String(registered.length)),
        h('dt', null, 'Авто-повтор'), h('dd', { title: retryLastError }, retryText),
        h('dt', null, 'Последняя ошибка'), h('dd', null, data.lastError ? String(data.lastError) : 'нет')),
      h('div', { className: 'dshMcpActions', style: { marginTop: '12px' } },
        h(Button, { variant: 'outline', onClick: props.onRetry, disabled: props.busy !== '' }, props.busy === 'retry' ? 'Подключаем…' : 'Подключить заново'),
        h(Button, { variant: 'outline', onClick: props.onRefresh, disabled: props.busy !== '' }, 'Обновить состояние')),
      h('p', { className: 'dshMcpFoot' }, '«Обновить состояние» только перечитывает статусы. «Подключить заново» повторяет монтирование серверов активного токена.')),
    gatewayWarnings.length === 0
      ? null
      : h('div', { className: 'dshMcpCard' },
        h('div', { className: 'dshMcpCardHead' },
          h('div', null,
            h('h3', { className: 'dshMcpCardTitle' }, 'Предупреждения шлюза'),
            h('p', { className: 'dshMcpCardNote' }, 'Часть состояния шлюза получена не полностью.'))),
        h('div', { className: 'dshMcpNotices' }, gatewayWarnings.map((text, index) => h(Notice, {
          key: 'gateway-' + String(index),
          text: text,
          tone: 'warn',
        })))),
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Диагностика'),
          h('p', { className: 'dshMcpCardNote' }, 'Полный отчёт плагина: реестр шлюза, ключи, восстановление ссылок на секреты.'))),
      diag.status === 'loading' ? h('div', { className: 'dshMcpEmpty' }, 'Загружаем диагностику…') : null,
      diag.status === 'error' ? h(Notice, { text: 'Диагностика недоступна: ' + diag.error, tone: 'bad' }) : null,
      diag.status === 'ready'
        ? h('details', { className: 'dshMcpDetails' },
          h('summary', null, 'Показать технический отчёт'),
          h('pre', { className: 'dshMcpPre' }, JSON.stringify(diag.data, null, 2)))
        : null),
    h('div', { className: 'dshMcpCard' },
      h('div', { className: 'dshMcpCardHead' },
        h('div', null,
          h('h3', { className: 'dshMcpCardTitle' }, 'Токены'),
          h('p', { className: 'dshMcpCardNote' }, 'Токен — это ключ LiteLLM и его права в шлюзе. Активный задаёт, что видят агенты этого DSH.'))),
      tokens.length === 0
        ? h('div', { className: 'dshMcpEmpty' }, 'Подключения нет — удалять нечего.')
        : h('div', null, tokens.map((token) => h('div', { className: 'dshMcpRow', key: token.id },
          h('div', { className: 'dshMcpRowMain' },
            h('span', { className: 'dshMcpRowTitle' }, token.label || token.id),
            h('span', { className: 'dshMcpRowMeta' },
              token.id
              + (token.active === true ? ' · активен' : '')
              + (token.fromConfig === true ? ' · из конфига' : ''))),
          h('div', { className: 'dshMcpActions' },
            token.active === true
              ? null
              : h(Button, {
                variant: 'outline',
                disabled: props.busy !== '',
                onClick: () => props.onSetActive(token.id),
              }, 'Сделать активным'),
            h(Button, {
              variant: 'outline',
              'aria-label': 'Удалить токен и ключ: ' + (token.label || token.id),
              disabled: props.busy !== '' || (token.active === true && tokens.length > 1),
              title: token.active === true && tokens.length > 1 ? 'сначала примените другой токен' : '',
              onClick: () => setDialog({ kind: 'remove', token: token }),
            }, 'Удалить'))))),
      h('p', { className: 'dshMcpFoot' }, 'Удаление снимает ключ LiteLLM. У токена из конфига запись в конфиге остаётся: его можно вернуть кнопкой «Вернуть».')),
    dialog !== null && dialog.kind === 'remove'
      ? h(RemoveTokenDialog, {
        token: dialog.token,
        lastToken: tokens.length === 1,
        onClose: () => setDialog(null),
        onRemove: (tokenId) => props.onRemoveToken(tokenId).then((payload) => {
          if (payload !== null) setDialog(null)
          return payload
        }),
      })
      : null)
}

/**
 * Вставка текста в композер активной сессии.
 *
 * Официального «положи в поле ввода» в клиентском рантайме нет, поэтому работаем с самим
 * композером: он contenteditable, и текст принимается только как пользовательский ввод —
 * execCommand('insertText') отправляет beforeinput+input, поэтому состояние React обновляется.
 * Автоотправку не делаем: инструкция на 20 КБ должна попасть в сессию после того, как человек
 * увидит, что именно он отправляет.
 * @param {string} text - текст промпта.
 * @returns {string} пустая строка — вставлено, иначе причина отказа.
 */
function insertPromptIntoComposer(text) {
  const box = document.querySelector('div[role="textbox"][contenteditable="true"]')
  if (box === null || box === undefined) return 'поле ввода сессии не найдено (открой новую сессию)'
  box.focus()
  const inserted = typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)
  if (inserted !== true) return 'браузер не дал вставить текст в поле ввода'
  return ''
}

/**
 * Раздел «Промпты»: markdown-инструкции из cfg.promptsDir с действиями «в сессию» и «копировать».
 * @param {object} props - data с сервера (state.prompts).
 * @returns {object} отрисованный раздел.
 */
function PromptsTab(props) {
  const prompts = (props.data !== null && props.data !== undefined && props.data.prompts) ? props.data.prompts : {}
  const dir = String(prompts.dir || '')
  const source = String(prompts.source || 'bundled')
  const items = Array.isArray(prompts.prompts) ? prompts.prompts : []
  const listError = String(prompts.error || '')
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState('')
  const fail = (error) => setNotice({ text: String(error && error.message ? error.message : error), tone: 'bad' })
  // Быстрый путь: сообщение уходит в очередь сессии сразу. Черновик не нужен — оболочке не
  // приходится перестраивать редактор под 15 КБ текста, поэтому отправка занимает миллисекунды.
  const send = (item) => {
    setBusy(item.id)
    setNotice(null)
    callApi('POST', '/prompts/item', { id: item.id }).then((payload) => {
      const text = String((payload && payload.text) || '')
      if (text === '') throw new Error('промпт пустой')
      return sendPromptToSession(text)
    }).then(() => setNotice({ text: 'Промпт «' + item.title + '» отправлен в активную сессию.', tone: 'ok' }))
      .catch(fail).then(() => setBusy(''))
  }
  // Медленный, но проверяемый путь: текст ложится в поле ввода, отправляет человек.
  const insert = (item) => {
    setBusy(item.id)
    setNotice(null)
    callApi('POST', '/prompts/item', { id: item.id }).then((payload) => {
      const text = String((payload && payload.text) || '')
      if (text === '') throw new Error('промпт пустой')
      const problem = putPromptIntoDraft(text)
      if (problem !== '') throw new Error(problem)
      setNotice({ text: 'Промпт «' + item.title + '» в поле ввода (15 КБ редактор перестраивает ~1–2 с) — проверьте и отправьте.', tone: 'ok' })
    }).catch(fail).then(() => setBusy(''))
  }
  const copy = (item) => {
    setBusy(item.id)
    setNotice(null)
    callApi('POST', '/prompts/item', { id: item.id }).then((payload) => {
      const text = String((payload && payload.text) || '')
      if (navigator.clipboard === undefined) throw new Error('буфер обмена недоступен в этом браузере')
      return navigator.clipboard.writeText(text)
    }).then(() => setNotice({ text: 'Промпт «' + item.title + '» скопирован.', tone: 'ok' }))
      .catch(fail).then(() => setBusy(''))
  }
  const sourceHint = source === 'bundled'
    ? 'Встроенные промпты плагина — предметные инструкции из репозитория, настраивать нечего.'
    : 'Инструкции из ' + dir + '.'
  return h('div', { className: 'dshMcpBlock' },
    h('div', { className: 'dshMcpBlockHead' },
      h('h3', { className: 'dshMcpCardTitle' }, 'Промпты для сессии'),
      h('p', { className: 'dshMcpHint' }, sourceHint + ' «Отправить» уходит в активную сессию сразу, «В поле ввода» — кладёт текст в черновик для проверки.')),
    h(Notice, { text: notice === null ? '' : notice.text, tone: notice === null ? '' : notice.tone }),
    h(Notice, { text: listError, tone: 'bad' }),
    items.length === 0
      ? h('div', { className: 'dshMcpEmpty' }, 'В каталоге нет ни одного .md.')
      : h('div', { className: 'dshMcpList' }, items.map((item) => h('div', { className: 'dshMcpRow', key: item.id },
        h('div', { className: 'dshMcpRowMain' },
          h('div', { className: 'dshMcpRowTitle' }, item.title),
          h('div', { className: 'dshMcpRowMeta' },
            h('code', null, item.id), ' · ', String(Math.max(1, Math.round(Number(item.bytes || 0) / 1024))), ' КБ · ',
            clockOf(item.updatedAt))),
        h('div', { className: 'dshMcpActions' },
          h(Button, { variant: 'primary', disabled: busy === item.id, onClick: () => send(item) },
            busy === item.id ? 'Отправляем…' : 'Отправить'),
          h(Button, { variant: 'outline', disabled: busy === item.id, onClick: () => insert(item) }, 'В поле ввода'),
          h(Button, { variant: 'outline', disabled: busy === item.id, onClick: () => copy(item) }, 'Копировать'))))))
}

function MCPAccessPanel() {
  const store = useMcpState()
  const [tab, setTab] = useState('access')
  const tabRefs = useRef({})
  const order = ['access', 'servers', 'prompts', 'extra']
  const onTabKey = (event) => {
    const index = order.indexOf(tab)
    let next = null
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length]
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length]
    else if (event.key === 'Home') next = order[0]
    else if (event.key === 'End') next = order[order.length - 1]
    if (next === null) return
    event.preventDefault()
    setTab(next)
    const node = tabRefs.current[next]
    if (node !== undefined && node !== null) node.focus()
  }
  const tabs = [
    { id: 'access', label: 'Доступ' },
    { id: 'servers', label: 'Серверы и инструменты' },
    { id: 'prompts', label: 'Промпты' },
    { id: 'extra', label: 'Дополнительно' },
  ]
  if (store.state.status === 'loading') {
    return h('div', { className: 'dshMcp' },
      h('div', { className: 'dshMcpHead' },
        h('div', null,
          h('h2', { className: 'dshMcpTitle' }, 'verme-gate'),
          h('p', { className: 'dshMcpHint' }, 'Загружаем состояние плагина…'))))
  }
  if (store.state.status === 'error') {
    return h('div', { className: 'dshMcp' },
      h('div', { className: 'dshMcpHead' },
        h('div', null,
          h('h2', { className: 'dshMcpTitle' }, 'verme-gate'),
          h('p', { className: 'dshMcpHint' }, 'Плагин не отвечает.'))),
      h(Notice, { text: store.state.error, tone: 'bad' }),
      h('p', { className: 'dshMcpFoot' }, 'Проверьте, что плагин verme-gate включён в профиле и его маршруты подняты.'),
      h('div', { className: 'dshMcpActions' },
        h(Button, { variant: 'outline', onClick: store.reload }, 'Повторить запрос')))
  }
  const data = store.state.data || {}
  const body = tab === 'access'
    ? h(AccessTab, {
      data: data,
      onConnectToken: (payload) => store.run('token-connect', '/token-connect', payload, 'Ключ подключён.'),
      onSaveTokenKey: (tokenId, value) => store.run('token-key', '/token-key', { token: tokenId, value: value }, 'Ключ заменён.'),
      onDisconnect: () => store.run('disconnect', '/disconnect', {}, 'Доступ отключён.'),
      onRestoreToken: (tokenId) => store.run('token-restore', '/token-restore', { token: tokenId }, 'Токен возвращён на экран.'),
      onOpenServers: () => setTab('servers'),
    })
    : tab === 'servers'
      ? h(ServersTab, {
        data: data,
        busy: store.busy !== '',
        busyKey: store.busy,
        onOpenAccess: () => setTab('access'),
        onSaveHeader: (server, name, value) => store.run('server-header', '/server-header', { server: server, name: name, value: value },
          value === '' ? 'Заголовок снят.' : 'Заголовок сохранён.'),
        onSaveEnvVar: (server, name, value) => store.run('env-var', '/env-var', { server: server, name: name, value: value },
          'Личное значение сохранено в шлюзе.'),
        onClearEnvVars: (server) => store.run('env-var-clear', '/env-var-clear', { server: server },
          'Личные значения сняты в шлюзе.'),
        onVerify: (server) => store.run('verify:' + server, '/verify', { server: server }, 'Проверка выполнена.', verifyNoticeOf),
      })
      : tab === 'prompts'
        ? h(PromptsTab, { data: data })
        : h(ExtraTab, {
        data: data,
        busy: store.busy,
        onRefresh: store.reload,
        onRetry: () => store.run('retry', '/refresh', {}, 'Повторное подключение выполнено.'),
        onSetActive: (tokenId) => store.run('token-active', '/active', { tokenId: tokenId }, 'Токен применён.'),
        onRemoveToken: (tokenId) => store.run('token-remove', '/token-remove', { token: tokenId }, 'Токен и его ключ удалены.'),
      })
  return h('div', { className: 'dshMcp' },
    h('div', { className: 'dshMcpHead' },
      h('div', null,
        h('h2', { className: 'dshMcpTitle' }, 'verme-gate'),
        h('p', { className: 'dshMcpHint' }, 'Ключ решает, что видит этот DSH.')),
      h('div', { className: 'dshMcpActions' },
        h(Button, { variant: 'outline', onClick: store.reload, disabled: store.busy !== '' }, store.busy === 'refresh' ? 'Обновляем…' : 'Обновить'))),
    store.notice !== null ? h(Notice, { text: store.notice.text, tone: store.notice.tone }) : null,
    h('div', { className: 'dshMcpTabs', role: 'tablist', 'aria-label': 'Разделы verme-gate' },
      tabs.map((item) => h('button', {
        key: item.id,
        ref: (node) => { tabRefs.current[item.id] = node },
        type: 'button',
        role: 'tab',
        id: 'dshMcpTab-' + item.id,
        className: 'dshMcpTab',
        'aria-selected': tab === item.id,
        'aria-controls': 'dshMcpPanel',
        tabIndex: tab === item.id ? 0 : -1,
        onClick: () => setTab(item.id),
        onKeyDown: onTabKey,
      }, item.label))),
    h('div', { id: 'dshMcpPanel', role: 'tabpanel', 'aria-labelledby': 'dshMcpTab-' + tab, tabIndex: 0 }, body))
}

/** Контекст плагина: нужен для доступа к сервису sessions из компонентов. */
let pluginCtx = null

/**
 * Активная сессия: шелл держит текущее выделение через retain-источник mainView.
 * Публичного «getCurrentSessionId» в 0.2.1-rc.2 нет (UiSession.current приватный), поэтому
 * используем тот же предикат, что и сам ui-workspace.
 * @returns {{ id: string, scope: object|null, binding: object|null }|null} сессия либо null.
 */
function activeSession() {
  if (pluginCtx === null || pluginCtx.sessions === undefined || pluginCtx.sessions === null) return null
  try {
    const list = pluginCtx.sessions.list.getSnapshot()
    const ids = Object.keys(list.byId)
    const id = ids.find((key) => Number((list.byId[key].retainedBy && list.byId[key].retainedBy.mainView) || 0) > 0)
    if (id === undefined) return null
    return {
      id: id,
      scope: pluginCtx.sessions.scope(id) || null,
      binding: pluginCtx.sessions.binding(id) || null,
    }
  } catch {
    return null
  }
}

/**
 * Положить текст в поле ввода активной сессии.
 *
 * Штатный путь — SessionInput.setDraft (черновик без отправки); DOM-вставка остаётся запасным
 * вариантом для случая, когда сервис недоступен (старая версия клиента).
 * @param {string} text - текст промпта.
 * @returns {string} пустая строка — вставлено, иначе причина отказа.
 */
function putPromptIntoDraft(text) {
  const active = activeSession()
  const conversation = pluginCtx === null ? null : pluginCtx.conversation
  if (active !== null && active.scope !== null && conversation !== null && conversation !== undefined && conversation.input !== undefined) {
    try {
      {
        const input = conversation.input.for(active.scope)
        input.setDraft(text)
        if (typeof input.focus === 'function') input.focus()
        return ''
      }
    } catch (error) {
      // Падать в DOM-запасной путь: текст важнее способа.
    }
  }
  return insertPromptIntoComposer(text)
}

/**
 * Отправить текст в активную сессию: сообщение встаёт в очередь, композер не участвует.
 * @param {string} text - текст промпта.
 * @returns {Promise<void>} завершается, когда сообщение принято оболочкой.
 */
function sendPromptToSession(text) {
  const active = activeSession()
  if (active === null) return Promise.reject(new Error('активная сессия не найдена — откройте сессию и повторите'))
  const conversation = pluginCtx === null ? null : pluginCtx.conversation
  // Штатный путь оболочки: ConversationController.sendSession(face, text, attachments, mode).
  // Черновик не участвует, поэтому 15 КБ уходят за миллисекунды, а не за секунды вёрстки.
  if (conversation !== null && typeof conversation.sendSession === 'function' && active.binding !== null) {
    return Promise.resolve(conversation.sendSession(active.binding.session, text, [], 'queue'))
  }
  // Запасной путь для клиента без этого метода: черновик + submit.
  if (active.scope !== null && conversation !== null && conversation.input !== undefined) {
    const input = conversation.input.for(active.scope)
    input.setDraft(text)
    if (typeof input.submit === 'function') input.submit('queue')
    return Promise.resolve()
  }
  return Promise.reject(new Error('клиент не умеет отправлять в сессию'))
}

function apply(ctx) {
  pluginCtx = ctx
  ctx.effect(() => {
    if (typeof document === 'undefined') return undefined
    const tag = document.createElement('style')
    tag.dataset.plugin = 'verme-gate'
    tag.textContent = STYLE
    document.head.appendChild(tag)
    return () => tag.remove()
  }, 'verme-gate: styles')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'verme-gate',
    order: 60,
    label: () => 'verme-gate',
    inject: () => ({}),
  }, MCPAccessPanel))
  // Строка под полем ввода: сколько денег осталось у ключа, как индикатор квоты в codex-плагине.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'verme-gate-budget',
    order: 20,
    inject: () => ({}),
  }, BudgetChip))
  // Рядом с бюджетом: есть ли новая версия плагина и та ли сборка DSH, под которую он собран.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock',
    id: 'verme-gate-update',
    order: 21,
    inject: () => ({}),
  }, UpdateChip))
}

exports.NS = NS
exports.inject = inject
exports.apply = apply

return module.exports; } });
