/**
 * Modal dialogs. Move section dialog goes in {@link module:Section#move}.
 *
 * @module modal
 */

import CdError from './CdError';
import Comment from './Comment';
import cd from './cd';
import { addPreventUnloadCondition, removePreventUnloadCondition } from './eventHandlers';
import { checkboxField, radioField } from './ooui';
import { defined, removeDuplicates, spacesToUnderlines } from './util';
import { encodeWikilink } from './wikitext';
import { getPageIds, getPageTitles } from './apiWrappers';
import { getSettings, getWatchedSections, setSettings, setWatchedSections } from './options';
import { handleApiReject, underlinesToSpaces } from './util';

/**
 * Create an OOUI window manager. It is supposed to be reused across the script.
 */
export function createWindowManager() {
  if (cd.g.windowManager) return;
  cd.g.windowManager = new OO.ui.WindowManager()
    .on('opening', () => {
      cd.g.pageOverlayOn = true;
    })
    .on('closing', () => {
      cd.g.pageOverlayOn = false;
    });
  $(document.body).append(cd.g.windowManager.$element);
}

/**
 * @typedef {object} OoUiRadioSelectWidget
 * @see https://doc.wikimedia.org/oojs-ui/master/js/#!/api/OO.ui.RadioSelectWidget
 */

/**
 * Get selected item data if any item is selected, or null otherwise.
 *
 * @param {OoUiRadioSelectWidget} select
 * @returns {?*}
 * @private
 */
function getSelectedItemData(select) {
  const selectedItem = select.findSelectedItem();
  return selectedItem && selectedItem.getData();
}

/**
 * Check if there are unsaved changes in a process dialog.
 *
 * @param {OoUiProcessDialog} dialog
 * @returns {boolean}
 * @private
 */
function isUnsaved(dialog) {
  const saveButton = dialog.actions.get({ actions: 'save' })[0];
  return saveButton && !saveButton.isDisabled();
}

/**
 * @typedef {object} OoUiProcessDialog
 * @see https://doc.wikimedia.org/oojs-ui/master/js/#!/api/OO.ui.ProcessDialog
 */

/**
 * Confirm closing a process dialog.
 *
 * @param {OoUiProcessDialog} dialog
 * @param {string} dialogCode
 * @private
 */
async function confirmCloseDialog(dialog, dialogCode) {
  if (!isUnsaved(dialog) || (await confirmDestructive(`${dialogCode}-close-confirm`))) {
    dialog.close({ action: 'close' });
    removePreventUnloadCondition('dialog');
  }
}

/**
 * Standard process dialog error handler.
 *
 * @param {CdError|Error} e
 * @param {string} messageName
 */
function handleError(e, messageName) {
  if (e instanceof CdError) {
    const { type, code, apiData } = e.data;
    this.showErrors(new OO.ui.Error(
      cd.s(messageName, type, apiData ? apiData.error.code : code),
      true
    ));
    console.warn(type, code, apiData);
  } else {
    this.showErrors(new OO.ui.Error(cd.s('error-javascript'), false));
    console.warn(e);
  }
  this.popPending();
}

/**
 * Show a settings dialog.
 */
export async function settingsDialog() {
  if (cd.g.pageOverlayOn) return;

  /**
   * @class Subclass of {@link
   *   https://doc.wikimedia.org/oojs-ui/master/js/#!/api/OO.ui.ProcessDialog OO.ui.ProcessDialog}
   *   used to create a settings dialog.
   * @private
   */
  function SettingsDialog() {
    SettingsDialog.parent.call(this);
  }
  OO.inheritClass(SettingsDialog, OO.ui.ProcessDialog);

  SettingsDialog.static.name = 'settingsDialog';
  SettingsDialog.static.title = cd.s('sd-title');
  SettingsDialog.static.actions = [
    {
      modes: ['loading', 'settings', 'reload', 'dataRemoved'],
      flags: ['safe', 'close'],
      action: 'close',
    },
    {
      modes: ['settings'],
      action: 'save',
      label: cd.s('sd-save'),
      flags: ['primary', 'progressive'],
      disabled: true,
    },
    {
      modes: ['reload'],
      action: 'reload',
      label: cd.s('sd-reload'),
      flags: ['primary', 'progressive'],
    },
  ];

  SettingsDialog.prototype.initialize = async function () {
    SettingsDialog.parent.prototype.initialize.apply(this, arguments);

    this.pushPending();

    const $loading = $('<div>').text(cd.s('loading-ellipsis'));

    this.panelLoading = new OO.ui.PanelLayout({
      padded: true,
      expanded: false,
    });
    this.panelLoading.$element.append($loading);

    this.panelSettings = new OO.ui.PanelLayout({
      padded: true,
      expanded: false,
    });

    const $settingsSaved = $('<p>').html(cd.s('sd-saved'));

    this.panelReload = new OO.ui.PanelLayout({
      padded: true,
      expanded: false,
    });
    this.panelReload.$element.append($settingsSaved);

    const $dataRemoved = $('<p>').html(cd.s('sd-dataremoved'));

    this.panelDataRemoved = new OO.ui.PanelLayout({
      padded: true,
      expanded: false,
    });
    this.panelDataRemoved.$element.append($dataRemoved);

    this.stackLayout = new OO.ui.StackLayout({
      items: [this.panelLoading, this.panelSettings, this.panelReload, this.panelDataRemoved],
    });

    this.$body.append(this.stackLayout.$element);
  };

  SettingsDialog.prototype.getSetupProcess = function (data) {
    return SettingsDialog.parent.prototype.getSetupProcess.call(this, data).next(() => {
      this.stackLayout.setItem(this.panelLoading);
      this.actions.setMode('loading');
    });
  };

  SettingsDialog.prototype.getReadyProcess = function (data) {
    return SettingsDialog.parent.prototype.getReadyProcess.call(this, data).next(async () => {
      let settings;
      try {
        await preparationsRequest;
        settings = await getSettings();
      } catch (e) {
        handleError(e, 'sd-error-load');
        return;
      }
      this.settings = Object.assign({}, cd.settings, settings);

      // For testing purposes
      cd.g.settingsForm = this;

      this.renderForm(this.settings);

      this.stackLayout.setItem(this.panelSettings);
      this.actions.setMode('settings');

      cd.g.windowManager.updateWindowSize(this);
      this.popPending();

      addPreventUnloadCondition('dialog', () => isUnsaved(dialog));
    });
  };

  SettingsDialog.prototype.getActionProcess = function (action) {
    if (action === 'save') {
      return new OO.ui.Process(async () => {
        this.pushPending();

        const settings = {};
        settings.allowEditOthersComments = this.allowEditOthersCommentsCheckbox.isSelected();
        settings.alwaysExpandSettings = this.alwaysExpandSettingsCheckbox.isSelected();
        settings.autopreview = this.autopreviewCheckbox.isSelected();
        settings.browserNotifications = (
          getSelectedItemData(this.browserNotificationsSelect) || 'unknown'
        );
        settings.defaultCommentLinkType = getSelectedItemData(this.defaultCommentLinkTypeSelect);
        settings.defaultSectionLinkType = getSelectedItemData(this.defaultSectionLinkTypeSelect);
        settings.highlightOwnComments = this.highlightOwnCommentsCheckbox.isSelected();
        settings.insertButtons = this.processInsertButtons();
        settings.mySignature = this.mySignatureInput.getValue();
        settings.notifications = getSelectedItemData(this.notificationsSelect);
        settings.notificationsBlacklist = this.notificationsBlacklistMultiselect.getValue();
        settings.showToolbar = this.showToolbarCheckbox.isSelected();
        settings.watchSectionOnReply = this.watchSectionOnReplyCheckbox.isSelected();

        settings.insertButtonsChanged = (
          JSON.stringify(settings.insertButtons) !==
          JSON.stringify(cd.defaultSettings.insertButtons)
        );

        try {
          await setSettings(settings);
        } catch (e) {
          handleError(e, 'sd-error-save');
          return;
        }

        this.stackLayout.setItem(this.panelReload);
        this.actions.setMode('reload');

        this.popPending();
      });
    } else if (action === 'reload') {
      return new OO.ui.Process(() => {
        this.close({ action });
        location.reload();
      });
    } else if (action === 'close') {
      return new OO.ui.Process(async () => {
        confirmCloseDialog(this, 'sd');
      });
    }
    return SettingsDialog.parent.prototype.getActionProcess.call(this, action);
  };

  SettingsDialog.prototype.renderForm = function (settings) {
    [this.allowEditOthersCommentsField, this.allowEditOthersCommentsCheckbox] = checkboxField({
      value: 'allowEditOthersComments',
      selected: settings.allowEditOthersComments,
      label: cd.s('sd-alloweditotherscomments'),
    });

    [this.alwaysExpandSettingsField, this.alwaysExpandSettingsCheckbox] = checkboxField({
      value: 'alwaysExpandSettings',
      selected: settings.alwaysExpandSettings,
      label: cd.s('sd-alwaysexpandsettings'),
    });

    [this.autopreviewField, this.autopreviewCheckbox] = checkboxField({
      value: 'autopreview',
      selected: settings.autopreview,
      label: cd.s('sd-autopreview'),
    });

    [
      this.browserNotificationsField,
      this.browserNotificationsSelect,
      this.browserNotificationsRadioAll,
      this.browserNotificationsRadioNone,
      this.browserNotificationsRadioToMe,
    ] = radioField({
      options: [
        {
          label: cd.s('sd-browsernotifications-radio-all'),
          data: 'all',
        },
        {
          label: cd.s('sd-browsernotifications-radio-tome'),
          data: 'toMe',
        },
        {
          label: cd.s('sd-browsernotifications-radio-none'),
          data: 'none',
        },
      ],
      selected: settings.browserNotifications,
      label: cd.s('sd-browsernotifications'),
      help: cd.s('sd-browsernotifications-help', location.host),
    });

    let defaultCommentLinkTypeHelp = cd.s('sd-defaultcommentlinktype-help');
    if (cd.config.defaultCommentLinkType === 'diff') {
      defaultCommentLinkTypeHelp += ` ${cd.s('sd-defaultcommentlinktype-help-notdifflinks')}`;
    }
    [
      this.defaultCommentLinkTypeField,
      this.defaultCommentLinkTypeSelect,
      this.defaultCommentLinkTypeRadioWikilink,
      this.defaultCommentLinkTypeRadioLink,
    ] = radioField({
      options: [
        {
          label: cd.s('sd-defaultcommentlinktype-radio-diff'),
          data: 'diff',
        },
        {
          label: cd.s('sd-defaultcommentlinktype-radio-wikilink'),
          data: 'wikilink',
        },
        {
          label: cd.s('sd-defaultcommentlinktype-radio-link'),
          data: 'link',
        },
      ],
      selected: settings.defaultCommentLinkType,
      label: cd.s('sd-defaultcommentlinktype', cd.s('cm-copylink')),
      help: defaultCommentLinkTypeHelp,
    });

    [
      this.defaultSectionLinkTypeField,
      this.defaultSectionLinkTypeSelect,
      this.defaultSectionLinkTypeRadioWikilink,
      this.defaultSectionLinkTypeRadioLink,
    ] = radioField({
      options: [
        {
          label: cd.s('sd-defaultsectionlinktype-radio-wikilink'),
          data: 'wikilink',
        },
        {
          label: cd.s('sd-defaultsectionlinktype-radio-link'),
          data: 'link',
        },
      ],
      selected: settings.defaultSectionLinkType,
      label: cd.s('sd-defaultsectionlinktype'),
      help: cd.s('sd-defaultsectionlinktype-help'),
    });

    [this.highlightOwnCommentsField, this.highlightOwnCommentsCheckbox] = checkboxField({
      value: 'highlightOwnComments',
      selected: settings.highlightOwnComments,
      label: cd.s('sd-highlightowncomments'),
    });

    const insertButtonsSelected = settings.insertButtons
      .map((button) => Array.isArray(button) ? button.join(';') : button);
    this.insertButtonsMultiselect = new OO.ui.TagMultiselectWidget({
      placeholder: cd.s('sd-insertbuttons-multiselect-placeholder'),
      allowArbitrary: true,
      inputPosition: 'outline',
      tagLimit: 100,
      selected: insertButtonsSelected,
    });
    this.insertButtonsField = (
      new OO.ui.FieldLayout(this.insertButtonsMultiselect, {
        label: cd.s('sd-insertbuttons'),
        align: 'top',
        help: cd.util.wrapInElement(cd.s('sd-insertbuttons-help')),
        helpInline: true,
      })
    );

    this.mySignatureInput = new OO.ui.TextInputWidget({
      value: settings.mySignature,
      maxlength: 100,
      // eslint-disable-next-line
      validate: /~~\~~/,
    });
    this.mySignatureField = new OO.ui.FieldLayout(this.mySignatureInput, {
      label: cd.s('sd-mysignature'),
      align: 'top',
      help: cd.util.wrapInElement(cd.s('sd-mysignature-help')),
      helpInline: true,
    });

    [
      this.notificationsField,
      this.notificationsSelect,
      this.notificationsRadioAll,
      this.notificationsRadioNone,
      this.notificationsRadioToMe,
    ] = radioField({
      options: [
        {
          label: cd.s('sd-notifications-radio-all'),
          data: 'all',
        },
        {
          label: cd.s('sd-notifications-radio-tome'),
          data: 'toMe',
        },
        {
          label: cd.s('sd-notifications-radio-none'),
          data: 'none',
        },
      ],
      selected: settings.notifications,
      label: cd.s('sd-notifications'),
      help: cd.s('sd-notifications-help'),
    });

    this.notificationsBlacklistMultiselect = new mw.widgets.UsersMultiselectWidget({
      placeholder: cd.s('sd-notificationsblacklist-multiselect-placeholder'),
      tagLimit: 100,
      selected: settings.notificationsBlacklist,
    });
    this.notificationsBlacklistField = (
      new OO.ui.FieldLayout(this.notificationsBlacklistMultiselect, {
        label: cd.s('sd-notificationsblacklist'),
        align: 'top',
      })
    );

    [this.showToolbarField, this.showToolbarCheckbox] = checkboxField({
      value: 'showToolbar',
      selected: settings.showToolbar,
      label: cd.s('sd-showtoolbar'),
    });

    [this.watchSectionOnReplyField, this.watchSectionOnReplyCheckbox] = checkboxField({
      value: 'watchSectionOnReply',
      selected: settings.watchSectionOnReply,
      label: cd.s('sd-watchsectiononreply'),
    });

    this.mainFieldset = new OO.ui.FieldsetLayout();
    this.mainFieldset.addItems([
      this.highlightOwnCommentsField,
      this.allowEditOthersCommentsField,
      this.defaultCommentLinkTypeField,
      this.defaultSectionLinkTypeField,
    ]);

    this.notificationsFieldset = new OO.ui.FieldsetLayout(
      { label: cd.s('sd-fieldset-notifications') }
    );
    this.notificationsFieldset.addItems([
      this.notificationsField,
      this.browserNotificationsField,
      this.notificationsBlacklistField,
    ]);

    this.commentFormFieldset = new OO.ui.FieldsetLayout({
      label: cd.s('sd-fieldset-commentform')
    });
    this.commentFormFieldset.addItems([
      this.autopreviewField,
      this.watchSectionOnReplyField,
      this.showToolbarField,
      this.alwaysExpandSettingsField,
      this.insertButtonsField,
      this.mySignatureField,
    ]);

    this.insertButtonsMultiselect.connect(this, { change: 'updateActionsAvailability' });
    this.allowEditOthersCommentsCheckbox.connect(this, { change: 'updateActionsAvailability' });
    this.alwaysExpandSettingsCheckbox.connect(this, { change: 'updateActionsAvailability' });
    this.autopreviewCheckbox.connect(this, { change: 'updateActionsAvailability' });
    this.browserNotificationsSelect.connect(
      this,
      {
        select: 'updateActionsAvailability',
        choose: 'changeBrowserNotifications',
      }
    );
    this.defaultCommentLinkTypeSelect.connect(this, { select: 'updateActionsAvailability' });
    this.defaultSectionLinkTypeSelect.connect(this, { select: 'updateActionsAvailability' });
    this.highlightOwnCommentsCheckbox.connect(this, { change: 'updateActionsAvailability' });
    this.mySignatureInput.connect(this, { change: 'updateActionsAvailability' });
    this.notificationsSelect.connect(this, { select: 'updateActionsAvailability' });
    this.notificationsBlacklistMultiselect.connect(this, { change: 'updateActionsAvailability' });
    this.showToolbarCheckbox.connect(this, { change: 'updateActionsAvailability' });
    this.watchSectionOnReplyCheckbox.connect(this, { change: 'updateActionsAvailability' });

    this.resetSettingsButton = new OO.ui.ButtonInputWidget({
      label: cd.s('sd-reset'),
      flags: ['destructive'],
    });
    this.resetSettingsButton.connect(this, { click: 'resetSettings' });

    this.resetSettingsField = new OO.ui.FieldLayout(this.resetSettingsButton, {
      classes: ['cd-settings-resetSettings'],
    });

    this.removeDataButton = new OO.ui.ButtonInputWidget({
      label: cd.s('sd-removedata'),
      flags: ['destructive'],
    });
    this.removeDataButton.connect(this, { click: 'removeData' });

    this.removeDataField = new OO.ui.FieldLayout(this.removeDataButton, {
      classes: ['cd-settings-removeData'],
    });

    this.panelSettings.$element.empty();
    this.panelSettings.$element.append(
      this.mainFieldset.$element,
      this.notificationsFieldset.$element,
      this.commentFormFieldset.$element,
      this.resetSettingsField.$element,
      this.removeDataField.$element
    );

    this.updateActionsAvailability();
  };

  SettingsDialog.prototype.processInsertButtons = function () {
    return this.insertButtonsMultiselect
      .getValue()
      .map((value) => {
        let [, text, displayedText] = value.match(/^(.*?[^\\])(?:;(.+))?$/) || [];
        if (!text || !text.replace(/^ +$/, '')) return;
        return [text, displayedText].filter(defined);
      })
      .filter(defined);
  };

  SettingsDialog.prototype.updateActionsAvailability = async function () {
    const insertButtonsJson = JSON.stringify(this.processInsertButtons());
    this.insertButtonsMultiselect.toggleValid(insertButtonsJson.length <= 10000);

    const notificationsBlacklistJson = JSON.stringify(
      this.notificationsBlacklistMultiselect.getValue()
    );
    this.notificationsBlacklistMultiselect.toggleValid(notificationsBlacklistJson.length <= 10000);

    const browserNotifications = getSelectedItemData(this.browserNotificationsSelect) || 'unknown';
    const defaultCommentLinkType = getSelectedItemData(this.defaultCommentLinkTypeSelect);
    const defaultSectionLinkType = getSelectedItemData(this.defaultSectionLinkTypeSelect);
    const notifications = getSelectedItemData(this.notificationsSelect);

    let save = (
      insertButtonsJson !== JSON.stringify(this.settings.insertButtons) ||
      this.allowEditOthersCommentsCheckbox.isSelected() !== this.settings.allowEditOthersComments ||
      this.alwaysExpandSettingsCheckbox.isSelected() !== this.settings.alwaysExpandSettings ||
      this.autopreviewCheckbox.isSelected() !== this.settings.autopreview ||
      browserNotifications !== this.settings.browserNotifications ||
      defaultCommentLinkType !== this.settings.defaultCommentLinkType ||
      defaultSectionLinkType !== this.settings.defaultSectionLinkType ||
      this.highlightOwnCommentsCheckbox.isSelected() !== this.settings.highlightOwnComments ||
      this.mySignatureInput.getValue() !== this.settings.mySignature ||
      notifications !== this.settings.notifications ||
      notificationsBlacklistJson !== JSON.stringify(this.settings.notificationsBlacklist) ||
      this.showToolbarCheckbox.isSelected() !== this.settings.showToolbar ||
      this.watchSectionOnReplyCheckbox.isSelected() !== this.settings.watchSectionOnReply
    );
    save = save && this.insertButtonsMultiselect.isValid();
    try {
      await this.mySignatureInput.getValidity();
    } catch (e) {
      save = false;
    }
    this.actions.setAbilities({ save });

    const enableReset = (
      (
        this.allowEditOthersCommentsCheckbox.isSelected() !==
        cd.defaultSettings.allowEditOthersComments
      ) ||
      this.alwaysExpandSettingsCheckbox.isSelected() !== cd.defaultSettings.alwaysExpandSettings ||
      this.autopreviewCheckbox.isSelected() !== cd.defaultSettings.autopreview ||
      browserNotifications !== cd.defaultSettings.browserNotifications ||
      defaultCommentLinkType !== cd.defaultSettings.defaultCommentLinkType ||
      defaultSectionLinkType !== cd.defaultSettings.defaultSectionLinkType ||
      this.highlightOwnCommentsCheckbox.isSelected() !== cd.defaultSettings.highlightOwnComments ||
      insertButtonsJson !== JSON.stringify(cd.defaultSettings.insertButtons) ||
      this.mySignatureInput.getValue() !== cd.defaultSettings.mySignature ||
      notifications !== cd.defaultSettings.notifications ||
      notificationsBlacklistJson !== JSON.stringify(cd.defaultSettings.notificationsBlacklist) ||
      this.showToolbarCheckbox.isSelected() !== cd.defaultSettings.showToolbar ||
      this.watchSectionOnReplyCheckbox.isSelected() !== cd.defaultSettings.watchSectionOnReply
    );
    this.resetSettingsButton.setDisabled(!enableReset);
  };

  SettingsDialog.prototype.changeBrowserNotifications = function (option) {
    if (option.data !== 'none' && Notification.permission !== 'granted') {
      OO.ui.alert(cd.s('alert-grantpermission'));
      Notification.requestPermission((permission) => {
        if (permission !== 'granted') {
          this.browserNotificationsSelect.selectItemByData('none');
        }
      });
    }
  };

  SettingsDialog.prototype.resetSettings = async function () {
    if (await OO.ui.confirm(cd.s('sd-reset-confirm'))) {
      this.renderForm(cd.defaultSettings);
    }
  };

  SettingsDialog.prototype.removeData = async function () {
    if (await confirmDestructive('sd-removedata-confirm')) {
      try {
        this.pushPending();

        const resp = await cd.g.api.postWithToken('csrf', {
          action: 'options',
          change: `${cd.g.SETTINGS_OPTION_FULL_NAME}|${cd.g.VISITS_OPTION_FULL_NAME}|${cd.g.WATCHED_SECTIONS_OPTION_FULL_NAME}`,
        }).catch(handleApiReject);

        if (!resp || resp.options !== 'success') {
          throw new CdError({
            type: 'api',
            code: 'noSuccess',
          });
        }
      } catch (e) {
        handleError(e, 'sd-error-removedata');
        return;
      }

      localStorage.removeItem('convenientDiscussions-commentForms');

      this.popPending();

      this.stackLayout.setItem(this.panelDataRemoved);
      this.actions.setMode('dataRemoved');
    }
  };

  const preparationsRequest = mw.loader.using(['mediawiki.widgets.UsersMultiselectWidget']);

  createWindowManager();
  const dialog = new SettingsDialog();
  cd.g.windowManager.addWindows([dialog]);
  let windowInstance = cd.g.windowManager.openWindow(dialog);
  windowInstance.closed.then(() => {
    cd.g.windowManager.clearWindows();
  });
}

/**
 * Show an edit watched sections dialog.
 */
export async function editWatchedSections() {
  if (cd.g.pageOverlayOn) return;

  /**
   * @class Subclass of {@link
   *   https://doc.wikimedia.org/oojs-ui/master/js/#!/api/OO.ui.ProcessDialog OO.ui.ProcessDialog}
   *   used to create an edit watched sections dialog.
   * @private
   */
  function EditWatchedSectionsDialog() {
    EditWatchedSectionsDialog.parent.call(this);
  }
  OO.inheritClass(EditWatchedSectionsDialog, OO.ui.ProcessDialog);

  EditWatchedSectionsDialog.static.name = 'editWatchedSectionsDialog';
  EditWatchedSectionsDialog.static.title = cd.s('ewsd-title');
  EditWatchedSectionsDialog.static.actions = [
    {
      action: 'save',
      label: cd.s('ewsd-save'),
      flags: ['primary', 'progressive'],
      disabled: true,
    },
    {
      action: 'close',
      flags: ['safe', 'close'],
    },
  ];

  EditWatchedSectionsDialog.prototype.initialize = async function () {
    EditWatchedSectionsDialog.parent.prototype.initialize.apply(this, arguments);

    this.pushPending();

    const $loading = $('<div>').text(cd.s('loading-ellipsis'));

    this.panelLoading = new OO.ui.PanelLayout({
      padded: true,
      expanded: false,
    });
    this.panelLoading.$element.append($loading);

    this.panelSections = new OO.ui.PanelLayout({
      padded: false,
      expanded: false,
    });

    this.stackLayout = new OO.ui.StackLayout({
      items: [this.panelLoading, this.panelSections],
    });

    this.$body.append(this.stackLayout.$element);
  };

  EditWatchedSectionsDialog.prototype.getSetupProcess = function (data) {
    return EditWatchedSectionsDialog.parent.prototype.getSetupProcess.call(this, data).next(() => {
      this.stackLayout.setItem(this.panelLoading);
    });
  };

  EditWatchedSectionsDialog.prototype.getReadyProcess = function (data) {
    return EditWatchedSectionsDialog.parent.prototype.getReadyProcess.call(this, data)
      .next(async () => {
        let watchedSections;
        let pages;
        try {
          ({ watchedSections } = await getWatchedSections());
          pages = await getPageTitles(
            Object.keys(watchedSections).filter((pageId) => watchedSections[pageId].length)
          );
        } catch (e) {
          handleError(e, 'ewsd-error-processing');
          return;
        }

        // Logically, there should be no coinciding titles between pages, so we don't need a separate
        // "return 0" condition.
        pages.sort((page1, page2) => page1.title > page2.title ? 1 : -1);

        const value = pages
          // Filter out deleted pages
          .filter((page) => page.title)

          .map((page) => (
            watchedSections[page.pageid]
              .map((section) => `${page.title}#${section}`)
              .join('\n')
          ))
          .join('\n');

        this.input = new OO.ui.MultilineTextInputWidget({
          value,
          rows: 30,
          classes: ['cd-editWatchedSections-input'],
        });
        this.input.on('change', (newValue) => {
          this.actions.setAbilities({ save: newValue !== value });
        });

        this.panelSections.$element.append(this.input.$element);

        this.stackLayout.setItem(this.panelSections);
        this.input.focus();

        // A dirty workaround avoid scrollbar appearing when the window is loading. Couldn't figure
        // out a way to do this out of the box.
        dialog.$body.css('overflow', 'hidden');
        setTimeout(() => {
          dialog.$body.css('overflow', '');
        }, 500);

        cd.g.windowManager.updateWindowSize(this);
        this.popPending();

        addPreventUnloadCondition('dialog', () => isUnsaved(dialog));
      });
  };

  EditWatchedSectionsDialog.prototype.getActionProcess = function (action) {
    if (action === 'save') {
      return new OO.ui.Process(async () => {
        this.pushPending();

        const sections = {};
        const pageTitles = [];
        this.input
          .getValue()
          .split('\n')
          .forEach((section) => {
            const match = section.match(/^(.+?)#(.+)$/);
            if (match) {
              const pageTitle = match[1].trim();
              const sectionTitle = match[2].trim();
              if (!sections[pageTitle]) {
                sections[pageTitle] = [];
                pageTitles.push(pageTitle);
              }
              sections[pageTitle].push(sectionTitle);
            }
          });

        let normalized;
        let redirects;
        let pages;
        try {
          ({ normalized, redirects, pages } = await getPageIds(pageTitles) || {});
        } catch (e) {
          handleError(e, 'ewsd-error-processing');
          return;
        }

        // Correct to normalized titles && redirect targets, add to the collection.
        normalized
          .concat(redirects)
          .filter((page) => sections[page.from])
          .forEach((page) => {
            if (!sections[page.to]) {
              sections[page.to] = [];
            }
            sections[page.to].push(...sections[page.from]);
            delete sections[page.from];
          });

        const titleToId = {};
        pages
          .filter((page) => page.pageid !== undefined)
          .forEach((page) => {
            titleToId[page.title] = page.pageid;
          });

        const newWatchedSections = {};
        Object.keys(sections)
          .filter((key) => titleToId[key])
          .forEach((key) => {
            newWatchedSections[titleToId[key]] = removeDuplicates(sections[key]);
          });

        try {
          await setWatchedSections(newWatchedSections);
          this.popPending();
          this.close();
        } catch (e) {
          if (e instanceof CdError) {
            const { type, code, apiData } = e.data;
            if (type === 'internal' && code === 'sizeLimit') {
              this.showErrors(new OO.ui.Error(cd.s('ewsd-error-maxsize'), false));
            } else {
              this.showErrors(new OO.ui.Error(
                cd.s('ewsd-error-processing', type, apiData ? apiData.error.code : code),
                true
              ));
            }
            console.warn(type, code, apiData);
          } else {
            this.showErrors(new OO.ui.Error(cd.s('error-javascript'), false));
            console.warn(e);
          }
          this.popPending();
          return;
        }
      });
    } else if (action === 'close') {
      return new OO.ui.Process(async () => {
        confirmCloseDialog(this, 'ewsd');
      });
    }
    return EditWatchedSectionsDialog.parent.prototype.getActionProcess.call(this, action);
  };

  createWindowManager();
  const dialog = new EditWatchedSectionsDialog();
  cd.g.windowManager.addWindows([dialog]);
  let windowInstance = cd.g.windowManager.openWindow(dialog);
  windowInstance.closed.then(() => {
    cd.g.windowManager.clearWindows();
  });
}

/**
 * Copy a link and notify whether the operation was successful.
 *
 * @param {string} text
 * @private
 */
function copyLinkToClipboardAndNotify(text) {
  const $textarea = $('<textarea>')
    .val(text)
    .appendTo(document.body)
    .select();
  const successful = document.execCommand('copy');
  $textarea.remove();

  if (successful) {
    if (text.startsWith('http')) {
      mw.notify(cd.util.wrapInElement(cd.s('copylink-copied-url', text)));
    } else {
      mw.notify(cd.s('copylink-copied'));
    }
  } else {
    mw.notify(cd.s('copylink-error'), { type: 'error' });
  }
}

/**
 * Copy a link to the object or show a copy link dialog.
 *
 * @param {Comment|Section} object
 * @param {boolean} chooseLink
 */
export async function copyLink(object, chooseLink) {
  let anchor = object instanceof Comment ? object.anchor : underlinesToSpaces(object.anchor);
  anchor = encodeWikilink(anchor);
  const wikilink = `[[${cd.g.CURRENT_PAGE}#${anchor}]]`;
  let decodedCurrentPageUrl;
  try {
    decodedCurrentPageUrl = decodeURI(mw.util.getUrl(cd.g.CURRENT_PAGE));
  } catch (e) {
    console.error(e);
    return;
  }
  const anchorWithUnderlines = spacesToUnderlines(anchor);
  const url = `https:${mw.config.get('wgServer')}${decodedCurrentPageUrl}#${anchorWithUnderlines}`;

  if (chooseLink) {
    let diffInput;
    let diffField;
    if (object instanceof Comment) {
      let diffLink;
      let value;
      try {
        value = diffLink = await object.getDiffLink(object);
      } catch (e) {
        if (e instanceof CdError) {
          const { type } = e.data;
          if (type === 'api') {
            value = cd.s('cld-diff-error');
          } else if (type === 'network') {
            value = cd.s('cld-diff-error-network');
          }
        } else {
          value = cd.s('cld-diff-error-unknown');
        }
      }

      if (cd.g.pageOverlayOn) return;

      diffInput = new OO.ui.TextInputWidget({
        value: value || cd.s('cld-diff-error'),
        disabled: !diffLink,
      });
      const diffButton = new OO.ui.ButtonWidget({
        label: cd.s('cld-copy'),
        icon: 'articles',
        disabled: !diffLink,
      });
      diffButton.on('click', () => {
        copyLinkToClipboardAndNotify(diffInput.getValue());
        dialog.close();
      });
      diffField = new OO.ui.ActionFieldLayout(diffInput, diffButton, {
        align: 'top',
        label: cd.s('cld-diff'),
      });
    }

    let wikilinkFieldHelp;
    if (object instanceof Comment && cd.config.defaultCommentLinkType === 'diff') {
      wikilinkFieldHelp = cd.s('cld-wikilink-help-comment');
    }

    const wikilinkInput = new OO.ui.TextInputWidget({
      value: wikilink,
    });
    const wikilinkButton = new OO.ui.ButtonWidget({
      label: cd.s('cld-copy'),
      icon: 'articles',
    });
    wikilinkButton.on('click', () => {
      copyLinkToClipboardAndNotify(wikilinkInput.getValue());
      dialog.close();
    });
    const wikilinkField = new OO.ui.ActionFieldLayout(wikilinkInput, wikilinkButton, {
      align: 'top',
      label: cd.s('cld-wikilink'),
      help: wikilinkFieldHelp,
      helpInline: true,
    });

    const anchorWikilinkInput = new OO.ui.TextInputWidget({
      value: `[[#${anchor}]]`
    });
    const anchorWikilinkButton = new OO.ui.ButtonWidget({
      label: cd.s('cld-copy'),
      icon: 'articles',
    });
    anchorWikilinkButton.on('click', () => {
      copyLinkToClipboardAndNotify(anchorWikilinkInput.getValue());
      dialog.close();
    });
    const anchorWikilinkField = new OO.ui.ActionFieldLayout(
      anchorWikilinkInput,
      anchorWikilinkButton, {
        align: 'top',
        label: cd.s('cld-currentpagewikilink'),
      }
    );

    const linkInput = new OO.ui.TextInputWidget({
      value: url,
    });
    const linkButton = new OO.ui.ButtonWidget({
      label: cd.s('cld-copy'),
      icon: 'articles',
    });
    linkButton.on('click', () => {
      copyLinkToClipboardAndNotify(linkInput.getValue());
      dialog.close();
    });
    const linkField = new OO.ui.ActionFieldLayout(linkInput, linkButton, {
      align: 'top',
      label: cd.s('cld-link'),
    });

    const $message = $('<div>')
      .append(diffField && diffField.$element)
      .append(wikilinkField.$element)
      .append(anchorWikilinkField.$element)
      .append(linkField.$element);

    const dialog = new OO.ui.MessageDialog();
    cd.g.windowManager.addWindows([dialog]);
    const windowInstance = cd.g.windowManager.openWindow(dialog, {
      message: $message,
      actions: [
        {
          label: cd.s('cld-close'),
          action: 'close',
        },
      ],
      size: 'large',
    });
    windowInstance.closed.then(() => {
      cd.g.windowManager.clearWindows();
    });
  } else {
    let link;
    const defaultType = cd.settings[
      object instanceof Comment ? 'defaultCommentLinkType' : 'defaultSectionLinkType'
    ];
    switch (defaultType) {
      case 'diff':
        if (!(object instanceof Comment)) {
          link = wikilink;
          break;
        }
        try {
          link = await object.getDiffLink(object);
        } catch (e) {
          let text;
          if (e instanceof CdError) {
            const { type } = e.data;
            if (type === 'network') {
              text = cd.s('copylink-error-diffnotfound-network');
            } else {
              const url = mw.util.getUrl(this.sourcePage, { action: 'history' });
              text = cd.util.wrapInElement(cd.s('copylink-error-diffnotfound', url));
            }
          } else {
            text = cd.s('copylink-error-diffnotfound-unknown');
          }
          mw.notify(text, { type: 'error' });
          return;
        }
        break;
      case 'link':
        link = url;
        break;
      default:
        link = wikilink;
    }

    copyLinkToClipboardAndNotify(link);
  }
}

/**
 * Show a modal with content of comment forms that we were unable to restore to the page (because
 * their target comments/sections disappeared, for example).
 *
 * @param {object[]} content
 * @param {string} [content[].headline]
 * @param {string} content[].comment
 * @param {string} content[].summary
 */
export function rescueCommentFormsContent(content) {
  const text = content
    .map((data) => {
      let text = data.headline !== undefined ?
        `${cd.s('cf-headline')}: ${data.headline}\n\n` :
        '';
      text += `${data.comment}\n\n${cd.s('cf-summary-placeholder')}: ${data.summary}`;
      return text;
    })
    .join('\n\n----\n');

  const input = new OO.ui.MultilineTextInputWidget({
    value: text,
    rows: 20,
  });
  const field = new OO.ui.FieldLayout(input, {
    align: 'top',
    label: cd.s('rd-intro'),
  });

  const dialog = new OO.ui.MessageDialog();
  cd.g.windowManager.addWindows([dialog]);
  const windowInstance = cd.g.windowManager.openWindow(dialog, {
    message: field.$element,
    actions: [
      { label: cd.s('rd-close'), action: 'close' },
    ],
    size: 'large',
  });
  windowInstance.closed.then(() => {
    cd.g.windowManager.clearWindows();
  });
}

/**
 * Display a OOUI message dialog where user is asked to confirm something. Compared to
 * `OO.ui.confirm`, returns an action string, not a boolean (which helps to differentiate between
 * more than two types of answer and also a window close by pressing Esc).
 *
 * @param {JQuery|string} message
 * @param {object} [options={}]
 * @returns {boolean}
 */
export async function confirmDialog(message, options = {}) {
  const defaultOptions = {
    message,
    // OO.ui.MessageDialog standard
    actions: [
      {
        action: 'accept',
        label: OO.ui.deferMsg('ooui-dialog-message-accept'),
        flags: 'primary',
      },
      {
        action: 'reject',
        label: OO.ui.deferMsg('ooui-dialog-message-reject'),
        flags: 'safe',
      },
    ],
  };

  const dialog = new OO.ui.MessageDialog();
  cd.g.windowManager.addWindows([dialog]);
  const windowInstance = cd.g.windowManager.openWindow(
    dialog,
    Object.assign({}, defaultOptions, options)
  );

  const data = await windowInstance.closed;
  cd.g.windowManager.clearWindows();
  return data && data.action;
}

/**
 * Show a confirmation message dialog with a destructive action.
 *
 * @param {string} messageName
 * @returns {Promise}
 */
export function confirmDestructive(messageName) {
  const actions = [
    {
      label: cd.s(`${messageName}-yes`),
      action: 'accept',
      flags: ['primary', 'destructive'],
    },
    {
      label: cd.s(`${messageName}-no`),
      action: 'reject',
      flags: 'safe',
    },
  ];
  return OO.ui.confirm(cd.s(messageName), { actions });
}

/**
 * Show a message dialog that informs the user that the section/comment was not found.
 *
 * @param {string} decodedFragment
 * @param {Date} date
 */
export async function notFound(decodedFragment, date) {
  const title = $('<span>')
    .addClass('cd-destructiveText')
    .html(date ? cd.s('deadanchor-comment-title') : cd.s('deadanchor-section-title'));
  let message = date ? cd.s('deadanchor-comment-text') : cd.s('deadanchor-section-text');
  const pageHasArchives = (
    !cd.config.pagesWithoutArchivesRegexp ||
    !cd.config.pagesWithoutArchivesRegexp.test(cd.g.CURRENT_PAGE)
  );
  if (pageHasArchives) {
    message += ' ' + cd.s('deadanchor-searchinarchive');

    if (await OO.ui.confirm(message, { title })) {
      let text;
      if (date) {
        text = cd.util.formatDate(date);
      } else {
        text = decodedFragment
          .replace(/_/g, ' ')
          .replace(/"/g, '')
          .trim();
      }
      const archivePrefix = cd.config.getArchivePrefix ?
        cd.config.getArchivePrefix(mw.config.get('wgTitle')) :
        mw.config.get('wgTitle');
      const searchQuery = (
        `"${text}" prefix:` +
        mw.config.get('wgFormattedNamespaces')[cd.g.CURRENT_NAMESPACE_NUMBER] +
        `:${archivePrefix}`
      );
      const url = mw.util.getUrl('Special:Search', {
        profile: 'default',
        fulltext: 'Search',
        search: searchQuery,
      });
      location.assign(mw.config.get('wgServer') + url);
    }
  } else {
    OO.ui.alert(message, { title });
  }
}
