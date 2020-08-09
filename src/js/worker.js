/**
 * Web worker entry point.
 *
 * Note that currently there may be difficulties in testing the web worker in the "local" mode with
 * custom config functions such as {@link module:defaultConfig.checkForCustomForeignComponents} due to
 * the (unfortunate) use of `eval()` here and the fact that webpack renames some objects in some
 * contexts resulting in a lost tie between them.
 *
 * @module worker
 */

import CdError from './CdError';
import CommentSkeleton from './CommentSkeleton';
import Parser from './Parser';
import SectionSkeleton from './SectionSkeleton';
import cd from './cd';
import debug from './debug';
import g from './staticGlobals';
import { getAllTextNodes, parseDOM } from './htmlparser2Extended';
import { resetCommentAnchors } from './timestamp';

self.cd = cd;
cd.g = g;
cd.debug = debug;
cd.debug.init();

let firstRun = true;

const context = {
  CommentClass: CommentSkeleton,
  SectionClass: SectionSkeleton,
  childElementsProperty: 'childElements',
  follows: (el1, el2) => el1.follows(el2),
  getAllTextNodes,
  getElementByClassName: (node, className) => {
    const elements = node.getElementsByClassName(className, 1);
    return elements[0] || null;
  },
};

let alarmTimeout;

/**
 * Send a "wake up" message to the window after the specified interval.
 *
 * @param {number} interval
 * @private
 */
function setAlarm(interval) {
  clearTimeout(alarmTimeout);
  alarmTimeout = setTimeout(() => {
    postMessage({ type: 'wakeUp' });
  }, interval);
}

/**
 * Parse the page and send a message to the window.
 *
 * @private
 */
function parse() {
  cd.comments = [];
  cd.sections = [];
  resetCommentAnchors();

  cd.debug.startTimer('processing comments');

  const parser = new Parser(context);

  cd.debug.startTimer('find timestamps');
  const timestamps = parser.findTimestamps();
  cd.debug.stopTimer('find timestamps');

  cd.debug.startTimer('find signatures');
  const signatures = parser.findSignatures(timestamps);
  cd.debug.stopTimer('find signatures');

  signatures.forEach((signature) => {
    try {
      const comment = parser.createComment(signature);
      if (comment.id !== undefined) {
        cd.comments.push(comment);
      }
    } catch (e) {
      if (!(e instanceof CdError)) {
        console.error(e);
      }
    }
  });

  cd.debug.stopTimer('processing comments');
  cd.debug.startTimer('processing sections');

  parser.findHeadings().forEach((heading) => {
    try {
      const section = parser.createSection(heading);
      if (section.id !== undefined) {
        cd.sections.push(section);
      }
    } catch (e) {
      if (!(e instanceof CdError)) {
        console.error(e);
      }
    }
  });

  cd.debug.startTimer('identifying replies');
  cd.comments.forEach((comment) => {
    comment.getChildren().forEach((reply) => {
      reply.targetComment = comment;
    });
    if (comment.getSection()) {
      comment.section = {
        headline: comment.getSection().headline,
        anchor: comment.getSection().anchor,
      }
      delete comment.getSection;
    }
    if (comment.targetComment) {
      comment.targetCommentAuthorName = comment.targetComment.authorName;
      comment.toMe = comment.targetComment.own;
      delete comment.targetComment;
    }
    delete comment.parser;
    delete comment.elements;
    delete comment.parts;
    delete comment.highlightables;
    delete comment.addAttributes;
    delete comment.setLevels;
    delete comment.getSection;
    delete comment.cachedSection;
    delete comment.getChildren;
  });
  cd.debug.stopTimer('identifying replies');

  cd.debug.stopTimer('processing sections');
  cd.debug.startTimer('post message from the worker');

  postMessage({
    type: 'parse',
    comments: cd.comments,
  });

  cd.debug.stopTimer('post message from the worker');
  cd.debug.stopTimer('worker operations');
  cd.debug.logAndResetEverything();
}

/**
 * Callback for messages from the window.
 *
 * @param {Event} e
 * @private
 */
function onMessageFromWindow(e) {
  const message = e.data;

  if (firstRun) {
    console.debug('Convenient Discussions\' web worker has been successfully loaded. Click the link from the file name and line number to open the source code in your debug tool. Note that there is a bug in Chrome (https://bugs.chromium.org/p/chromium/issues/detail?id=1111297) that prevents opening the source code in that browser while it\'s OK in Firefox.');
    firstRun = false;
  }

  if (message.type === 'setAlarm') {
    setAlarm(message.interval);
  }

  if (message.type === 'removeAlarm') {
    clearTimeout(alarmTimeout);
  }

  if (message.type === 'parse') {
    cd.debug.startTimer('worker operations');

    Object.assign(cd.g, message.g);
    cd.config = message.config;

    // FIXME: Any idea how to avoid using eval() here?
    let checker = cd.config.checkForCustomForeignComponents;
    if (checker && !/^ *function +/.test(checker) && !/^.+=>/.test(checker)) {
      checker = 'function ' + checker;
    }
    cd.config.checkForCustomForeignComponents = eval(checker);

    cd.g.TIMESTAMP_PARSER = eval(cd.g.TIMESTAMP_PARSER);

    cd.debug.startTimer('parse html');

    const dom = parseDOM(message.text, {
      withStartIndices: true,
      withEndIndices: true,
    });

    cd.debug.stopTimer('parse html');

    cd.g.rootElement = new Document(dom);
    context.document = cd.g.rootElement;
    cd.g.specialElements = {
      pageHasOutdents: Boolean(
        cd.g.rootElement.getElementsByClassName('outdent-template', 1).length
      ),
    };

    parse();
  }
}

onmessage = onMessageFromWindow;
