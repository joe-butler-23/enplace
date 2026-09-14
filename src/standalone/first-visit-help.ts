export function shouldShowFirstVisitHelp(helpAcknowledged: boolean, firstUseNoticeVisible: boolean): boolean {
  return !helpAcknowledged && !firstUseNoticeVisible;
}
