/**
 * 功能概述：固定的隔离 world DOM 读取与单次激活函数，不执行模型提供的 JavaScript。
 * 主要职责：读取页面结构/表单属性形成观察；激活时在同一 renderer 任务中重验原状态与截止。
 * 代码库关系：browser component 用 CDP 指定隔离 world 并独立传参；输入函数无异步续发，
 * 点击为 DOM activation，fill/select 通过原生 setter 与 input/change 事件更新应用。
 * 输入输出与副作用：输入前检查完整 HTML、表单属性、视口和 URL；暴露复选框及单选框实时选中状态，继承禁用的控件不得输入。
 */
export function readDom() {
  const viewport = {
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
    x: scrollX,
    y: scrollY,
  };
  const inputs = [...document.querySelectorAll("input,textarea,select")].map(
    (e) => [e.tagName, e.type, e.value, e.checked, e.selectedIndex],
  );
  const html = document.documentElement?.outerHTML ?? "";
  if (html.length > 1048576 || inputs.length > 4096)
    throw new Error("browser-state-too-large");
  const nodes = [
    ...document.querySelectorAll(
      "a,button,input,textarea,select,output,[role],h1,h2,h3,label,[aria-live]",
    ),
  ]
    .slice(0, 256)
    .map((element, index) => {
      const chain = [];
      for (
        let e = element;
        e?.nodeType === Node.ELEMENT_NODE;
        e = e.parentElement
      ) {
        const tag = e.tagName.toLowerCase();
        const siblings = e.parentElement
          ? [...e.parentElement.children].filter((s) => s.tagName === e.tagName)
          : [e];
        chain.push(tag + ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")");
      }
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        id: "n" + index,
        selector: chain.reverse().join(">"),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        type: element.getAttribute("type"),
        checked:
          element.tagName === "INPUT" &&
          ["checkbox", "radio"].includes(element.type)
            ? element.checked
            : undefined,
        name: (
          element.getAttribute("aria-label") ??
          element.getAttribute("placeholder") ??
          element.innerText ??
          element.textContent ??
          ""
        )
          .trim()
          .slice(0, 512),
        value:
          element.type === "password"
            ? undefined
            : typeof element.value === "string"
              ? element.value.slice(0, 32768)
              : undefined,
        text: (element.innerText ?? element.textContent ?? "")
          .trim()
          .slice(0, 4096),
        href: element.tagName === "A" ? element.href : undefined,
        disabled:
          element.matches(":disabled") ||
          element.getAttribute("aria-disabled") === "true" ||
          !!element.closest("[inert]"),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        visible:
          box.width > 0 &&
          box.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none",
        inViewport:
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < innerHeight &&
          box.left < innerWidth,
      };
    });
  return {
    url: location.href,
    title: document.title,
    viewport,
    html,
    inputs,
    nodes,
    text: (document.body?.innerText ?? "").slice(0, 65536),
  };
}

export const readDomExpression = `(${readDom.toString()})()`;
export const activateDomFunction = `function(args) {
  const state = (${readDom.toString()})();
  const identity = {url: state.url, viewport: state.viewport, html: state.html, inputs: state.inputs};
  if (JSON.stringify(identity) !== JSON.stringify(args.expected)) return {dispatched:false,reason:'stale-observation'};
  const element = args.selector ? document.querySelector(args.selector) : null;
  if (args.action !== 'navigate' && (!element || element.matches(':disabled'))) return {dispatched:false,reason:'node-unavailable'};
  if (args.action !== 'navigate') {
    const current = state.nodes.find(node=>node.selector===args.selector);
    if (!current?.visible || !current.inViewport || current.disabled || JSON.stringify(current.box)!==JSON.stringify(args.expectedBox)) return {dispatched:false,reason:'node-actionability-changed'};
    if (args.action==='fill' && element.readOnly) return {dispatched:false,reason:'read-only-control'};
  }
  // 隔离 world 的 Date 不受页面脚本覆盖；此后无 await 或后台输入任务。
  if (Date.now() >= args.deadline) return {dispatched:false,reason:'permit-expired'};
  if (args.action === 'navigate') {
    location.assign(args.url);
  } else if (args.action === 'click') {
    HTMLElement.prototype.click.call(element);
  } else if (args.action === 'fill') {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement && ['text','search','email','password','url','tel','number'].includes(element.type))) return {dispatched:false,reason:'not-a-text-control'};
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,args.value);
    if (Date.now() >= args.deadline) return {dispatched:true,reason:'expired-after-value'};
    element.dispatchEvent(new Event('input',{bubbles:true}));
    if (Date.now() >= args.deadline) return {dispatched:true,reason:'expired-after-input'};
    element.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (args.action === 'select') {
    if (!(element instanceof HTMLSelectElement) || ![...element.options].some(option=>option.value===args.value)) return {dispatched:false,reason:'option-unavailable'};
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(element,args.value);
    if (Date.now() >= args.deadline) return {dispatched:true,reason:'expired-after-value'};
    element.dispatchEvent(new Event('input',{bubbles:true}));
    if (Date.now() >= args.deadline) return {dispatched:true,reason:'expired-after-input'};
    element.dispatchEvent(new Event('change',{bubbles:true}));
  } else return {dispatched:false,reason:'unsupported-browser-action'};
  return {dispatched:true};
}`;
