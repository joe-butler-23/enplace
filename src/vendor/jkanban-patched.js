/**
 * Lean local fork of jKanban 1.3.1.
 * Upstream: https://github.com/riktar/jkanban
 * License: Apache-2.0
 */

import dragula from "dragula";
import { buildJKanbanCardElement } from "../kanban-core/patcher";
import { classTokens } from "../kanban-core/lifecycle";
import { KANBAN_ACTION_ATTRIBUTE } from "../kanban-core/selectors";

const defaults = {
	element: "",
	gutter: "15px",
	widthBoard: "250px",
	boards: [],
	dragItems: true,
	copyItem: false,
	copySortSource: false,
	dragEl() {},
	dragendEl() {},
	dropEl() {},
};

function addClasses(element, classes) {
	element.classList.add(...classTokens(classes));
}

export default function jKanban(options = {}) {
	const self = this;
	this.options = { ...defaults, ...options };
	this.element = this.options.element;
	this.boardContainer = [];
	this.drake = null;

	if (!this.element) return;

	const container = document.createElement("div");
	container.classList.add("kanban-container");
	this.container = container;

	for (const board of this.options.boards) {
		const boardElement = document.createElement("div");
		boardElement.dataset.id = board.id;
		boardElement.dataset.order = String(container.childNodes.length + 1);
		boardElement.classList.add("kanban-board");
		boardElement.style.width = this.options.widthBoard;
		boardElement.style.marginLeft = this.options.gutter;
		boardElement.style.marginRight = this.options.gutter;

		const header = document.createElement("header");
		header.classList.add("kanban-board-header");
		addClasses(header, board.headerClasses);
		header.innerHTML = `<div class="kanban-title-board">${board.titleHtml}</div>`;

		const cards = document.createElement("div");
		cards.classList.add("kanban-drag");
		addClasses(cards, board.bodyClasses);
		this.boardContainer.push(cards);

		for (const card of board.cards) {
			cards.appendChild(buildJKanbanCardElement(card));
		}

		boardElement.append(header, cards, document.createElement("footer"));
		container.appendChild(boardElement);
	}

	this.element.appendChild(container);

	this.drake = dragula(this.boardContainer, {
		moves: (element, _source, handle) =>
			Boolean(self.options.dragItems) &&
			!element.classList.contains("not-draggable") &&
			!handle.closest(`[${KANBAN_ACTION_ATTRIBUTE}]`),
		copy(element, source) {
			return typeof self.options.copyItem === "function"
				? Boolean(self.options.copyItem(element, source))
				: Boolean(self.options.copyItem);
		},
		copySortSource: Boolean(self.options.copySortSource),
		revertOnSpill: true,
	})
		.on("drag", (element, source) => {
			element.classList.add("is-moving");
			self.options.dragEl(element, source);
		})
		.on("dragend", (element) => {
			element.classList.remove("is-moving");
			self.options.dragendEl(element);
		})
		.on("drop", (element, target, source, sibling) => {
			if (self.options.dropEl(element, target, source, sibling) === false) {
				self.drake.cancel(true);
			}
		});

	this.findBoard = (id) =>
		this.element.querySelector(`[data-id="${CSS.escape(id)}"]`);

	this.destroy = () => {
		this.drake?.destroy();
		this.container?.remove();
		this.boardContainer = [];
		this.drake = null;
		this.container = null;
		return this;
	};
}
