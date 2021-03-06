/**
 * Main module.
 *
 * @module app
 */

import { create as nanoCssCreate } from 'nano-css';

import Comment from './Comment';
import CommentForm from './CommentForm';
import Section from './Section';
import Worker from './worker';
import cd from './cd';
import commentLinks from './commentLinks';
import debug from './debug';
import defaultConfig from './config/default';
import g from './staticGlobals';
import processPage from './processPage';
import util from './globalUtil';
import { defined, isProbablyTalkPage, underlinesToSpaces } from './util';
import { formatDate, parseCommentAnchor } from './timestamp';
import { loadMessages } from './dateFormat';
import { removeLoadingOverlay, setLoadingOverlay } from './boot';
import { setVisits } from './options';

import '../less/global.less';

let config;
let strings;
if (IS_LOCAL) {
  config = require(`./config/${CONFIG_FILE_NAME}`).default;
  strings = require(`./i18n/${LANG_FILE_NAME}`).default;
}

/**
 * Get a language string.
 *
 * @param {string} name
 * @param {...*} params
 * @returns {?string}
 * @memberof module:cd~convenientDiscussions
 */
function s(name, ...params) {
  if (!name) {
    return null;
  }
  const fullName = `convenientdiscussions-${name}`;
  if (!cd.g.QQX_MODE && typeof mw.messages.get(fullName) === 'string') {
    const message = mw.message(fullName, ...params);
    return typeof params[params.length - 1] === 'object' && params[params.length - 1].plain ?
      message.plain() :
      message.toString();
  } else {
    const paramsString = params.length ? `: ${params.join(', ')}` : '';
    return `(${fullName}${paramsString})`;
  }
}

/**
 * The main script function.
 *
 * @private
 * @fires launched
 */
function main() {
  // Doesn't work in mobile version.
  if (location.host.endsWith('.m.wikipedia.org')) return;

  if (cd.isRunning) {
    console.warn('One instance of Convenient Discussions is already running.');
    return;
  }

  /**
   * Is the script running.
   *
   * @name isRunning
   * @type {boolean}
   * @memberof module:cd~convenientDiscussions
   */
  cd.isRunning = true;

  /**
   * Script configuration. Default configuration is at {@link module:default/config}.
   *
   * @name config
   * @type {object}
   * @memberof module:cd~convenientDiscussions
   */
  cd.config = Object.assign(defaultConfig, cd.config);

  if (IS_LOCAL) {
    cd.config = Object.assign(defaultConfig, config);
    cd.strings = strings;
  }

  /**
   * @see module:debug
   * @name debug
   * @type {object}
   * @memberof module:cd~convenientDiscussions
   */
  cd.debug = debug;

  cd.g = g;
  cd.s = s;
  cd.util = util;

  /**
   * @see module:Comment.getCommentByAnchor Get a comment by anchor
   * @function getCommentByAnchor
   * @memberof module:cd~convenientDiscussions
   */
  cd.getCommentByAnchor = Comment.getCommentByAnchor;

  /**
   * @see module:Section.getSectionByAnchor Get a section by anchor
   * @function getSectionByAnchor
   * @memberof module:cd~convenientDiscussions
   */
  cd.getSectionByAnchor = Section.getSectionByAnchor;

  /**
   * @see module:Section.getSectionsByHeadline
   * @function getSectionsByHeadline
   * @memberof module:cd~convenientDiscussions
   */
  cd.getSectionsByHeadline = Section.getSectionsByHeadline;

  /**
   * @see module:CommentForm.getLastActiveCommentForm
   * @function getLastActiveCommentForm
   * @memberof module:cd~convenientDiscussions
   */
  cd.getLastActiveCommentForm = CommentForm.getLastActiveCommentForm;

  /**
   * @see module:CommentForm.getLastActiveAlteredCommentForm
   * @function getLastActiveAlteredCommentForm
   * @memberof module:cd~convenientDiscussions
   */
  cd.getLastActiveAlteredCommentForm = CommentForm.getLastActiveAlteredCommentForm;


  /* Some utilities that we believe should be global for external use. */

  /**
   * @see module:timestamp.parseCommentAnchor
   * @function parseCommentAnchor
   * @memberof module:cd~convenientDiscussions.util
   */
  cd.util.parseCommentAnchor = parseCommentAnchor;

  /**
   * @see module:timestamp.formatDate
   * @function formatDate
   * @memberof module:cd~convenientDiscussions.util
   */
  cd.util.formatDate = formatDate;

  /**
   * @see module:options.setVisits
   * @function setVisits
   * @memberof module:cd~convenientDiscussions.util
   */
  cd.util.setVisits = setVisits;

  cd.debug.init();
  cd.debug.startTimer('start');
  cd.debug.startTimer('total time');

  /**
   * The script has launched.
   *
   * @event launched
   * @type {module:cd~convenientDiscussions}
   */
  mw.hook('convenientDiscussions.launched').fire(cd);

  Object.keys(cd.strings).forEach((name) => {
    mw.messages.set(`convenientdiscussions-${name}`, cd.strings[name]);
  });

  cd.g.SETTINGS_OPTION_FULL_NAME = `userjs-${cd.config.optionsPrefix}-settings`;
  cd.g.VISITS_OPTION_FULL_NAME = `userjs-${cd.config.optionsPrefix}-visits`;

  // For historical reasons, ru.wikipedia.org has 'watchedTopics'.
  const watchedSectionsOptionName = location.host === 'ru.wikipedia.org' ?
    'watchedTopics' :
    'watchedSections';
  cd.g.WATCHED_SECTIONS_OPTION_FULL_NAME = (
    `userjs-${cd.config.optionsPrefix}-${watchedSectionsOptionName}`
  );

  cd.g.$content = $('#mw-content-text');
  cd.g.IS_DIFF_PAGE = mw.config.get('wgIsArticle') && /[?&]diff=[^&]/.test(location.search);
  cd.g.CURRENT_PAGE = underlinesToSpaces(mw.config.get('wgPageName'));
  cd.g.CURRENT_NAMESPACE_NUMBER = mw.config.get('wgNamespaceNumber');
  cd.g.CURRENT_USER_NAME = mw.config.get('wgUserName');

  cd.g.pageOverlayOn = false;

  // Go
  if (
    mw.config.get('wgIsArticle') &&
    (
      isProbablyTalkPage(cd.g.CURRENT_PAGE, cd.g.CURRENT_NAMESPACE_NUMBER) ||
      cd.g.$content.find('.cd-talkPage').length
    )
  ) {
    cd.g.firstRun = true;

    cd.g.nanoCss = nanoCssCreate();
    cd.g.nanoCss.put('.cd-loadingPopup', {
      width: cd.config.logoWidth,
    });
    cd.g.nanoCss.put('.cd-loadingPopup-logo', {
      width: cd.config.logoWidth,
      height: cd.config.logoHeight,
    });

    setLoadingOverlay();

    cd.debug.stopTimer('start');
    cd.debug.startTimer('load worker');
    cd.debug.startTimer('loading modules');

    // Load messages in advance if the API module is ready in order not to make 2 requests
    // sequentially.
    if (mw.loader.getState('mediawiki.api') === 'ready') {
      cd.g.api = new mw.Api();
      cd.g.messagesRequest = loadMessages();
    }

    cd.g.worker = new Worker();

    // We use a jQuery promise as there is no way to know the state of native promises.
    const modulesRequest = $.when(...[
      mw.loader.using([
        'jquery.color',
        'jquery.client',
        'mediawiki.Title',
        'mediawiki.api',
        'mediawiki.cookie',
        'mediawiki.jqueryMsg',
        'mediawiki.notification',
        'mediawiki.user',
        'mediawiki.util',
        'mediawiki.widgets.visibleLengthLimit',
        'oojs',
        'oojs-ui',
        'oojs-ui.styles.icons-alerts',
        'oojs-ui.styles.icons-content',
        'oojs-ui.styles.icons-interactions',
        'user.options',
      ]),
      cd.g.messagesRequest,
    ].filter(defined)).then(
      () => {
        try {
          processPage();
        } catch (e) {
          mw.notify(cd.s('error-processpage'), { type: 'error' });
          removeLoadingOverlay();
          console.error(e);
        }
      },
      (e) => {
        mw.notify(cd.s('error-loaddata'), { type: 'error' });
        removeLoadingOverlay();
        console.warn(e);
      }
    );

    setTimeout(() => {
      // https://phabricator.wikimedia.org/T68598
      if (modulesRequest.state() !== 'resolved') {
        removeLoadingOverlay();
        console.warn('The promise is in the "pending" state for 10 seconds; removing the loading overlay.');
      }
    }, 10000);
  }

  if (
    ['Watchlist', 'Contributions', 'Recentchanges']
      .includes(mw.config.get('wgCanonicalSpecialPageName')) ||
    (
      mw.config.get('wgAction') === 'history' &&
      isProbablyTalkPage(cd.g.CURRENT_PAGE, cd.g.CURRENT_NAMESPACE_NUMBER)
    ) ||
    cd.g.IS_DIFF_PAGE
  ) {
    // Load messages in advance if the API module is ready in order not to make 2 requests
    // sequentially.
    if (mw.loader.getState('mediawiki.api') === 'ready') {
      cd.g.api = new mw.Api();
      cd.g.messagesRequest = loadMessages();
    }

    mw.loader.using([
      'user.options',
      'mediawiki.Title',
      'mediawiki.api',
      'mediawiki.jqueryMsg',
      'mediawiki.util',
      'mediawiki.user',
      'oojs',
      'oojs-ui',
      'oojs-ui.styles.icons-interactions',
      'oojs-ui.styles.icons-editing-list',
      'oojs-ui.styles.icons-alerts',
    ]).then(
      () => {
        commentLinks();
      },
      (e) => {
        console.warn(e);
      }
    );
  }
}

$(main);
