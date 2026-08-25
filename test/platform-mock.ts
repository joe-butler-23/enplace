import moment from "moment";
export { moment };

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; size: number };

  constructor(path: string, name: string, extension: string, stat?: { mtime: number; size: number }) {
    this.path = path;
    this.name = name;
    this.extension = extension;
    this.stat = stat ?? { mtime: Date.now(), size: 0 };
  }

  get basename() {
    return this.name.replace(/\.[^/.]+$/, "");
  }
}

export const normalizePath = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");

export class Notice {
  constructor(_message: string) {}
}

export class Modal {
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  modalEl: HTMLElement;

  constructor(_app: App) {
    this.modalEl = {} as HTMLElement;
    this.titleEl = {} as HTMLElement;
    this.contentEl = {} as HTMLElement;
  }

  open() {}
  close() {}
}

export class Plugin {}

export class App {}

export class TAbstractFile {
  path: string;
  name: string;

  constructor(path = "", name = "") {
    this.path = path;
    this.name = name;
  }
}

export class TFolder extends TAbstractFile {
  absolutePath: string;
  children: TAbstractFile[];

  constructor(path: string, name: string, absolutePath?: string) {
    super(path, name);
    this.absolutePath = absolutePath ?? path;
    this.children = [];
  }
}
