/**
 * Main module.
 *
 * @module app
 */

import { create as nanoCssCreate } from 'nano-css';

import Comment from './Comment';
import CommentForm from './CommentForm';
import Section from './Section';
import cd from './cd';
import commentLinks from './commentLinks';
import configUrls from './../../config/urls.json';
import debug from './debug';
import defaultConfig from './defaultConfig';
import enStrings from '../../i18n/en.json';
import g from './staticGlobals';
import processPage from './processPage';
import util from './globalUtil';
import { defined, isProbablyTalkPage, mergeRegexps, underlinesToSpaces } from './util';
import { formatDate, parseCommentAnchor } from './timestamp';
import { getUserInfo } from './apiWrappers';
import {
  initTalkPageCss,
  isLoadingOverlayOn,
  removeLoadingOverlay,
  setLoadingOverlay,
} from './boot';
import { loadMessages } from './dateFormat';
import { setVisits } from './options';

let config;
let strings;
if (IS_SNIPPET) {
  config = require(`../../config/${CONFIG_FILE_NAME}`).default;
  strings = require(`../../i18n/${LANG_FILE_NAME}`);
}

/**
 * Get a language string. The last parameter, if boolean, may indicate if the message should be
 * returned in the plain, not substituted, form.
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
  const fullName = `convenient-discussions-${name}`;
  if (!cd.g.QQX_MODE && typeof mw.messages.get(fullName) === 'string') {
    const message = mw.message(fullName, ...params.filter((param) => typeof param !== 'boolean'));
    return typeof params[params.length - 1] === 'boolean' && params[params.length - 1] ?
      message.plain() :
      message.toString();
  } else {
    const paramsString = params.length ? `: ${params.join(', ')}` : '';
    return `(${fullName}${paramsString})`;
  }
}

/**
 * When searching for a comment after clicking "OK" in a "Comment not found" dialog, add comment
 * links to the titles.
 *
 * @private
 */
function addCommentLinksOnSpecialSearch() {
  const [, commentAnchor] = location.search.match(/[?&]cdComment=([^&]+)(?:&|$)/) || [];
  if (commentAnchor) {
    mw.loader.using(['mediawiki.api']).then(
      async () => {
        await loadMessages();
        $('.mw-search-result-heading').each((i, el) => {
          const $a = $('<a>')
            .attr('href', $(el).find('a').first().attr('href') + '#' + commentAnchor)
            .text(cd.s('deadanchor-search-gotocomment'));
          const $span = $('<span>')
            .addClass("cd-searchCommentLink")
            .append(mw.msg('parentheses-start'), $a, mw.msg('parentheses-end'));
          $(el).append(' ', $span.clone());
        });
      },
      console.error
    );
  }
}

/**
 * Add a footer link to enable/disable CD.
 *
 * @param {boolean} enable
 */
function addFooterLink(enable) {
  const url = new URL(location.href);
  url.searchParams.set('cdTalkPage', enable ? '1' : '0');
  const $li = $('<li>').attr('id', enable ? 'footer-places-enablecd' : 'footer-places-disablecd');
  $('<a>')
    .attr('href', url.href)
    .addClass('noprint')
    .text(cd.s(enable ? 'footer-enablecd' : 'footer-disablecd'))
    .appendTo($li);
  $('#footer-places').append($li);
}

/**
 * Function executed after the config and localization strings are ready.
 *
 * @private
 */
function go() {
  /**
   * Script configuration. Default configuration is at {@link module:defaultConfig}.
   *
   * @name config
   * @type {object}
   * @memberof module:cd~convenientDiscussions
   */
  cd.config = Object.assign(defaultConfig, cd.config);

  cd.strings = Object.assign({}, enStrings, cd.strings);

  Object.keys(cd.strings).forEach((name) => {
    mw.messages.set(`convenient-discussions-${name}`, cd.strings[name]);
  });

  cd.g.SETTINGS_OPTION_FULL_NAME = `userjs-${cd.config.optionsPrefix}-settings`;
  cd.g.LOCAL_SETTINGS_OPTION_FULL_NAME = `userjs-${cd.config.optionsPrefix}-localSettings`;
  cd.g.VISITS_OPTION_FULL_NAME = `userjs-${cd.config.optionsPrefix}-visits`;

  // For historical reasons, ru.wikipedia.org has 'watchedTopics'.
  const watchedSectionsOptionName = location.host === 'ru.wikipedia.org' ?
    'watchedTopics' :
    'watchedSections';
  cd.g.WATCHED_SECTIONS_OPTION_FULL_NAME = (
    `userjs-${cd.config.optionsPrefix}-${watchedSectionsOptionName}`
  );

  cd.g.IS_DIFF_PAGE = mw.config.get('wgIsArticle') && /[?&]diff=[^&]/.test(location.search);
  cd.g.CURRENT_PAGE_NAME = underlinesToSpaces(mw.config.get('wgPageName'));
  cd.g.CURRENT_NAMESPACE_NUMBER = mw.config.get('wgNamespaceNumber');
  cd.g.CURRENT_USER_NAME = mw.config.get('wgUserName');
  cd.g.PAGE_WHITE_LIST_REGEXP = mergeRegexps(cd.config.pageWhiteList);
  cd.g.PAGE_BLACK_LIST_REGEXP = mergeRegexps(cd.config.pageBlackList);

  cd.g.$content = $('#mw-content-text');

  cd.config.customTalkNamespaces = (
    cd.config.customTalkNamespaces ||
    mw.config.get('wgExtraSignatureNamespaces')
  );

  // Process the page as a talk page
  if (
    mw.config.get('wgIsArticle') &&
    !/[?&]cdTalkPage=(0|false|no|n)(?=&|$)/.test(location.search) &&
    (
      isProbablyTalkPage(cd.g.CURRENT_PAGE_NAME, cd.g.CURRENT_NAMESPACE_NUMBER) ||
      $('#ca-addsection').length ||

      // .cd-talkPage is used as a last resort way to make CD parse the page, as opposed to using
      // the list of supported namespaces and page white/black list in the configuration. With this
      // method, there won't be "comment" links for edits on pages that list revisions such as the
      // watchlist.
      cd.g.$content.find('.cd-talkPage').length ||

      /[?&]cdTalkPage=(1|true|yes|y)(?=&|$)/.test(location.search)
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
    cd.debug.startTimer('loading data');

    // Make some requests in advance if the API module is ready in order not to make 2 requests
    // sequentially.
    let messagesRequest;
    if (mw.loader.getState('mediawiki.api') === 'ready') {
      messagesRequest = loadMessages();
      getUserInfo().catch((e) => {
        console.warn(e);
      });
    }

    // We use a jQuery promise as there is no way to know the state of native promises.
    $.when(...[
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
      messagesRequest,
    ].filter(defined)).then(
      () => {
        try {
          processPage({ messagesRequest });
        } catch (e) {
          mw.notify(cd.s('error-processpage'), { type: 'error' });
          removeLoadingOverlay();
          console.error(e);
        }
      },
      (e) => {
        // Note https://phabricator.wikimedia.org/T68598 "mw.loader state of module stuck at
        // "loading" if request was aborted"

        mw.notify(cd.s('error-loaddata'), { type: 'error' });
        removeLoadingOverlay();
        console.error(e);
      }
    );

    setTimeout(() => {
      if (isLoadingOverlayOn()) {
        removeLoadingOverlay();
        console.warn('The loading overlay stays for more than 10 seconds; removing it.');
      }
    }, 10000);

    // Additions of CSS cause a reflow which delays operations dependent on rendering, so we run it
    // now, not after the requests are fulfilled, to save time. The overall order is like this:
    // 1. Make API requests (above).
    // 2. Run operations dependent on rendering, such as window.getComputedStyle().
    // 3. Run operations that initiate a reflow, such as adding CSS. Thanks to the fact that the API
    // requests are already running, we don't lose time.
    cd.g.REGULAR_LINE_HEIGHT = parseFloat(window.getComputedStyle(cd.g.$content.get(0)).lineHeight);

    initTalkPageCss();

    require('../less/global.less');
    require('../less/Comment.less');
    require('../less/CommentForm.less');
    require('../less/Section.less');
    require('../less/commentLayers.less');
    require('../less/navPanel.less');
    require('../less/skin.less');
    require('../less/talkPage.less');

    addFooterLink(false);
  } else {
    addFooterLink(true);
  }

  // Process the page as a log page
  if (
    ['Watchlist', 'Contributions', 'Recentchanges']
      .includes(mw.config.get('wgCanonicalSpecialPageName')) ||
    (
      mw.config.get('wgAction') === 'history' &&
      isProbablyTalkPage(cd.g.CURRENT_PAGE_NAME, cd.g.CURRENT_NAMESPACE_NUMBER)
    ) ||
    cd.g.IS_DIFF_PAGE
  ) {
    // Make some requests in advance if the API module is ready in order not to make 2 requests
    // sequentially.
    let messagesRequest;
    if (mw.loader.getState('mediawiki.api') === 'ready') {
      messagesRequest = loadMessages();
      getUserInfo(true).catch((e) => {
        console.warn(e);
      });
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
        commentLinks({ messagesRequest });

        // See the comment above: "Additions of CSS...".
        require('../less/global.less');
        require('../less/logPages.less');
      },
      (e) => {
        mw.notify(cd.s('error-loaddata'), { type: 'error' });
        console.error(e);
      }
    );
  }

  if (mw.config.get('wgCanonicalSpecialPageName') === 'Search') {
    addCommentLinksOnSpecialSearch();
  }
}

/**
 * Helper function to decode base64 strings.
 *
 * @param {string} s
 * @returns {string}
 * @author Sophivorus
 * @license GPL-2.0-only
 * @license CC-BY-SA-3.0
 * @license GFDL-1.3
 * @private
 */
function decodeBase64(s) {
  return decodeURIComponent(
    window.atob(s)
      .split('')
      .map((character) => (
        '%' +
        ('00' + character.charCodeAt(0).toString(16))
          .slice(-2)
      ))
      .join('')
  );
}

/**
 * Load and execute the configuration script if available.
 *
 * @returns {Promise}
 * @private
 */
function getConfig() {
  return new Promise((resolve, reject) => {
    if (configUrls[location.host]) {
      if (IS_DEV) {
        configUrls[location.host] = configUrls[location.host].replace(/.js/, '-dev.js');
      }
      mw.loader.getScript(configUrls[location.host]).then(
        () => {
          resolve();
        },
        (e) => {
          reject(['Convenient Discussions can\'t run: couldn\'t load the configuration.', e]);
        }
      );
    } else {
      resolve();
    }
  });
}

/**
 * Load and add localization strings.
 *
 * @returns {Promise}
 * @private
 */
function getStrings() {
  const lang = mw.config.get('wgUserLanguage');
  return new Promise((resolve) => {
    if (lang === 'en') {
      // English strings are already in the build.
      resolve();
    } else {
      $.get(`https://gerrit.wikimedia.org/r/plugins/gitiles/mediawiki/gadgets/ConvenientDiscussions/+/master/i18n/${lang}.json?format=text`)
        .then(
          (data) => {
            cd.strings = JSON.parse(decodeBase64(data));
            resolve();
          },
          () => {
            // We assume it's OK to fall back to English if the translation is unavailable for any
            // reason. After all, something wrong could be with Gerrit.
            resolve();
          }
        );
    }
  });
}

/**
 * The main script function.
 *
 * @fires launched
 * @private
 */
async function app() {
  // Doesn't work in mobile version, isn't needed on Structured Discussions pages.
  if (location.host.endsWith('.m.wikipedia.org') || $('.flow-board-page').length) return;

  if (cd.running) {
    console.warn('One instance of Convenient Discussions is already running.');
    return;
  }

  /**
   * Is the script running.
   *
   * @name running
   * @type {boolean}
   * @memberof module:cd~convenientDiscussions
   */
  cd.running = true;

  if (IS_SNIPPET) {
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
   * @see module:Comment.getCommentByAnchor
   * @function getCommentByAnchor
   * @memberof module:cd~convenientDiscussions
   */
  cd.getCommentByAnchor = Comment.getCommentByAnchor;

  /**
   * @see module:Section.getSectionByAnchor
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
  cd.debug.startTimer('total time');
  cd.debug.startTimer('start');
  cd.debug.startTimer('load data');

  /**
   * The script has launched.
   *
   * @event launched
   * @type {module:cd~convenientDiscussions}
   */
  mw.hook('convenientDiscussions.launched').fire(cd);

  try {
    await Promise.all([
      !cd.config && getConfig(),
      // cd.getStringsPromise may be set in the configuration file.
      !cd.strings && (cd.getStringsPromise || getStrings()),
    ].filter(defined));
  } catch (e) {
    console.error(e);
    return;
  }

  cd.debug.stopTimer('load data');

  go();
}

$(app);
