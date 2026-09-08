declare namespace chrome {
  namespace alarms {
    type Alarm = {
      name: string;
      scheduledTime: number;
      periodInMinutes?: number;
    };

    type AlarmCreateInfo = {
      when?: number;
      delayInMinutes?: number;
      periodInMinutes?: number;
    };

    function create(name: string, alarmInfo: AlarmCreateInfo): Promise<void> | void;
    function clear(name: string): Promise<boolean>;

    const onAlarm: {
      addListener(listener: (alarm: Alarm) => void): void;
    };
  }

  namespace tabs {
    type Tab = {
      id?: number;
      windowId?: number;
      title?: string;
      url?: string;
      status?: string;
    };

    type MessageSendOptions = {
      frameId?: number;
      documentId?: string;
    };

    type QueryInfo = {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
    };

    type TabChangeInfo = {
      status?: string;
      url?: string;
    };

    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
    function get(tabId: number): Promise<Tab>;
    function remove(tabId: number): Promise<void>;
    function update(
      tabId: number,
      updateProperties: { active?: boolean; url?: string },
    ): Promise<Tab>;
    function sendMessage<T = unknown>(
      tabId: number,
      message: unknown,
      options?: MessageSendOptions,
    ): Promise<T>;

    const onRemoved: {
      addListener(listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void;
    };

    const onUpdated: {
      addListener(listener: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };

    // `tabs.onReplaced` is not a `webNavigation` event and carries no url, frame or document.
    // It names two tab ids and nothing else, so the bridge has to read the surviving tab
    // before it can say what was navigated to.
    const onReplaced: {
      addListener(listener: (addedTabId: number, removedTabId: number) => void): void;
    };
  }

  namespace webNavigation {
    // Only the fields the bridge reads. `documentLifecycle` and `documentId` exist from
    // Chrome 106; the manifest already requires 116, so both are always present in practice
    // and are still declared optional because a stub in a test may omit them.
    type NavigationDetails = {
      tabId: number;
      frameId: number;
      url: string;
      documentId?: string;
      documentLifecycle?: string;
      parentFrameId?: number;
      timeStamp?: number;
    };

    type NavigationEvent = {
      addListener(listener: (details: NavigationDetails) => void): void;
    };

    const onCommitted: NavigationEvent;
    const onHistoryStateUpdated: NavigationEvent;
    const onReferenceFragmentUpdated: NavigationEvent;
  }

  namespace windows {
    function update(
      windowId: number,
      updateInfo: { focused?: boolean },
    ): Promise<unknown>;
  }

  namespace runtime {
    type MessageSender = {
      id?: string;
      tab?: tabs.Tab;
      frameId?: number;
      documentId?: string;
      url?: string;
      origin?: string;
    };

    type SendResponse = (response?: unknown) => void;

    const id: string;

    const onMessage: {
      addListener<T = unknown>(
        listener: (
          message: T,
          sender: MessageSender,
          sendResponse: SendResponse,
        ) => boolean | void,
      ): void;
    };

    function sendMessage<T = unknown>(message: unknown): Promise<T>;
  }

  namespace storage {
    namespace local {
      function get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      function remove(keys: string | string[]): Promise<void>;
    }

    namespace session {
      function get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
      function set(items: Record<string, unknown>): Promise<void>;
      function remove(keys: string | string[]): Promise<void>;
    }
  }

  namespace permissions {
    type Permissions = {
      origins?: string[];
      permissions?: string[];
    };

    function contains(permissions: Permissions): Promise<boolean>;
    function request(permissions: Permissions): Promise<boolean>;
    function remove(permissions: Permissions): Promise<boolean>;
  }

  namespace contextMenus {
    type OnClickData = {
      menuItemId: string | number;
      selectionText?: string;
      pageUrl?: string;
      frameUrl?: string;
    };

    function create(createProperties: {
      id: string;
      title: string;
      contexts?: string[];
    }): string | number;
    function remove(menuItemId: string | number): Promise<void>;

    const onClicked: {
      addListener(listener: (info: OnClickData, tab?: tabs.Tab) => void): void;
    };
  }

  namespace scripting {
    type InjectionTarget = {
      tabId: number;
      frameIds?: number[];
      allFrames?: boolean;
    };

    type ScriptInjection = {
      target: InjectionTarget;
      files?: string[];
      world?: "ISOLATED" | "MAIN";
    };

    function executeScript(injection: ScriptInjection): Promise<unknown[]>;
  }
}
