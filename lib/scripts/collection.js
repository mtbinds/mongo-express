import $ from 'jquery';
import { encode } from 'html-entities';
import renderjson from 'renderjson-2';
import 'bootstrap-paginator-2';
import { Modal } from 'bootstrap';
import editor from './editor.js';

function getParameterByName(name) {
  // eslint-disable-next-line unicorn/better-regex
  name = name.replace(/\[/, String.raw`\[`).replace(/[\]]/, String.raw`\]`);
  const regex = new RegExp(String.raw`[\?&]` + name + '=([^&#]*)');
  const results = regex.exec(globalThis.location.search);
  return results === null ? '' : decodeURIComponent(results[1].replaceAll('+', ' '));
}

$(() => {
  $('#tabs').tab();
  if (document.location.href.includes('query=') && getParameterByName('query') !== '') {
    $('#tabs a[href="#advanced"]').tab('show');
  }

  // ── Query Console ───────────────────────────────────────────────────────────

  // Set placeholder via JS to avoid HTML-escaping issues
  const qcEl = document.querySelector('#qc_input');
  if (qcEl) {
    qcEl.placeholder = [
      '// Simple find',
      'db.listingsAndReviews.find({ "address.country": "Portugal" }, { name: 1, price: 1, _id: 0 })',
      '',
      '// Find with sort + limit',
      'db.listingsAndReviews.find({ bedrooms: { $gt: 4 }, price: { $lt: 150 } }).sort({ price: 1 }).limit(10)',
      '',
      '// Aggregation pipeline',
      'db.listingsAndReviews.aggregate([',
      '  { $group: { _id: "$property_type", count: { $sum: 1 } } },',
      '  { $sort: { count: -1 } }',
      '])',
    ].join('\n');
  }

  // Restore textarea after a search (show the last executed query)
  (function restoreQueryConsole() {
    const p = new URLSearchParams(globalThis.location.search);
    const qRaw = p.get('query') || '';
    const projRaw = (p.get('projection') || '').trim();
    const isAgg = p.get('runAggregate') === 'on' || p.get('runAggregate') === 'true';
    const sortKeys = [...p.keys()].filter((k) => k.startsWith('sort['));
    const sortObj = {};
    for (const k of sortKeys) sortObj[k.slice(5, -1)] = Number(p.get(k));
    const $ta = document.querySelector('#qc_input');
    if (!$ta || !qRaw) return;
    // Reconstruct a readable mongosh-style query
    if (isAgg) {
      try {
        const pipeline = JSON.parse(qRaw);
        $ta.value = 'db.listingsAndReviews.aggregate(' + JSON.stringify(pipeline, null, 2) + ')';
      } catch { $ta.value = qRaw; }
    } else {
      let out = 'db.listingsAndReviews.find(' + qRaw;
      if (projRaw) out += ', ' + projRaw;
      out += ')';
      if (Object.keys(sortObj).length > 0) out += '.sort(' + JSON.stringify(sortObj) + ')';
      $ta.value = out;
    }
  }());

  // ── Mongosh-style parser ──────────────────────────────────────────────────
  // Evaluates mongosh-like expressions using a safe Function() call with
  // MongoDB constructor shims (ISODate, ObjectId, etc.).
  function qcEval(code) {
    /* eslint-disable no-new-func */
    try {
      return new Function(
        'ISODate', 'ObjectId', 'NumberDecimal', 'NumberInt', 'NumberLong',
        'BinData', 'Timestamp', 'MinKey', 'MaxKey', 'UUID',
        '"use strict"; return (' + code + ')'
      )(
        (s) => ({ $date: s }),
        (s) => ({ $oid: s }),
        Number, Number, Number,
        (t, d) => ({ $binary: d }),
        (t, i) => ({ $timestamp: { t, i } }),
        'MinKey', 'MaxKey',
        (s) => ({ $uuid: s }),
      );
    } catch { return undefined; }
    /* eslint-enable no-new-func */
  }

  // Bracket-aware string slicer: finds the index of the closing char
  // matching the first opener (already consumed), skipping string literals.
  function findClose(str) {
    const opens = new Set(['(', '{', '[']);
    const closes = new Set([')', '}', ']']);
    let depth = 1;
    let inStr = false;
    let strChar = '';
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === strChar) inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true; strChar = c;
      } else if (opens.has(c)) {
        depth++;
      } else if (closes.has(c)) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Split top-level comma-separated arguments (respects nesting + strings)
  function splitArgs(str) {
    const args = [];
    let depth = 0;
    let inStr = false;
    let strChar = '';
    let start = 0;
    for (let i = 0; i <= str.length; i++) {
      const c = str[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === strChar) inStr = false;
      } else if (c === '"' || c === "'") {
        inStr = true; strChar = c;
      } else if (c === '(' || c === '{' || c === '[') {
        depth++;
      } else if (c === ')' || c === '}' || c === ']') {
        depth--;
      } else if ((c === ',' || i === str.length) && depth === 0) {
        const arg = str.slice(start, i).trim();
        if (arg) args.push(arg);
        start = i + 1;
      }
    }
    return args;
  }

  // Parse a full mongosh-style query string into { type, filter, projection,
  // sort, pipeline, skip, limit } or null if not recognised.
  function parseMongosh(raw) {
    // Strip //  line comments, normalise whitespace
    const s = raw.replace(/\/\/[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();

    // Must start with db.<name>.<method>(
    const m = s.match(/^db\s*\.\s*\w+\s*\.\s*(find|aggregate|distinct|countDocuments)\s*\(/);
    if (!m) return null;

    const method = m[1];
    const afterParen = s.slice(m[0].length); // everything after the opening (
    const closeIdx = findClose(afterParen);
    if (closeIdx === -1) return null;

    const mainArgsStr = afterParen.slice(0, closeIdx);
    let rest = afterParen.slice(closeIdx + 1); // chain after )

    // Parse chained methods: .sort({}) .limit(n) .skip(n)
    let sortObj = {};
    let limitVal = null;
    let skipVal = null;
    let chainM;
    while ((chainM = rest.match(/^\s*\.\s*(sort|limit|skip|projection)\s*\(/))) {
      const cm = chainM[1];
      const afterCParen = rest.slice(chainM[0].length);
      const ci = findClose(afterCParen);
      if (ci === -1) break;
      const chainArgsStr = afterCParen.slice(0, ci);
      rest = afterCParen.slice(ci + 1);
      if (cm === 'sort') sortObj = qcEval(chainArgsStr) || {};
      else if (cm === 'limit') limitVal = Number(chainArgsStr.trim());
      else if (cm === 'skip') skipVal = Number(chainArgsStr.trim());
    }

    if (method === 'aggregate') {
      const pipeline = qcEval(mainArgsStr);
      if (!Array.isArray(pipeline)) return null;
      return { type: 'aggregate', pipeline };
    }

    if (method === 'distinct') {
      // Convert distinct("field") → aggregate [{$group:{_id:"$field"}},{$sort:{_id:1}}]
      const args = splitArgs(mainArgsStr);
      const field = qcEval(args[0]);
      if (typeof field !== 'string') return null;
      const pipeline = [{ $group: { _id: '$' + field } }, { $sort: { _id: 1 } }];
      return { type: 'aggregate', pipeline };
    }

    // find / countDocuments
    const args = splitArgs(mainArgsStr);
    const filter = args[0] ? qcEval(args[0]) : {};
    const projection = args[1] ? qcEval(args[1]) : {};
    return {
      type: 'find',
      filter: filter || {},
      projection: projection || {},
      sort: sortObj,
      skip: skipVal,
      limit: limitVal,
    };
  }

  // ── Form submit handler ────────────────────────────────────────────────────
  $('#queryConsoleForm').on('submit', function (e) {
    const $form = $(this);
    const raw = ($('#qc_input').val() || '').trim();
    if (!raw) { e.preventDefault(); return false; }

    const $hint = document.querySelector('#qc_hint');
    const setError = (msg) => {
      $hint.innerHTML = msg;
      $hint.style.color = 'red';
    };
    $hint.style.color = '';

    let result = parseMongosh(raw);

    // Fallback: plain JSON filter object or aggregate pipeline
    if (!result) {
      const val = qcEval(raw);
      if (val === undefined) {
        setError('Parse error — check your syntax.');
        e.preventDefault();
        return false;
      }
      if (Array.isArray(val)) {
        result = { type: 'aggregate', pipeline: val };
      } else if (val && typeof val === 'object') {
        result = { type: 'find', filter: val, projection: {}, sort: {} };
      } else {
        setError('Unrecognised input format.');
        e.preventDefault();
        return false;
      }
    }

    if (result.type === 'aggregate') {
      document.querySelector('#qc_query').value = JSON.stringify(result.pipeline);
      document.querySelector('#qc_projection').value = '';
      document.querySelector('#qc_runAggregate').value = 'on';
    } else {
      document.querySelector('#qc_query').value = JSON.stringify(result.filter);
      document.querySelector('#qc_projection').value =
        result.projection && Object.keys(result.projection).length
          ? JSON.stringify(result.projection) : '';
      document.querySelector('#qc_runAggregate').value = '';
      if (result.sort && Object.keys(result.sort).length > 0) {
        for (const [k, v] of Object.entries(result.sort)) {
          $('<input>').attr({ type: 'hidden', name: `sort[${k}]`, value: v }).appendTo($form);
        }
      }
      if (result.skip != null) {
        $('<input>').attr({ type: 'hidden', name: 'skip', value: result.skip }).appendTo($form);
      }
    }
    return true;
  });

  const { limit, skip, totalPages } = ME_SETTINGS;
  // https://jacobmarshall-etc.github.io/bootstrap-paginator
  const options = {
    currentPage: Math.round(skip / limit) + 1,
    totalPages,
    centerCurrentPage: true,
    onPageClicked(e, originalEvent, type, page) {
      const searchParams = new URLSearchParams(globalThis.location.search);
      searchParams.set('skip', (page * limit) - limit);
      globalThis.location.search = searchParams.toString();
    },
  };
  $('#paginator-top').bootstrapPaginator(options);
  $('#paginator-bottom').bootstrapPaginator(options);
});

const addDoc = editor(document.querySelector('#document'), {
  readOnly: ME_SETTINGS.readOnly,
});

const addIndexDoc = editor(document.querySelector('#index'), {
  readOnly: ME_SETTINGS.readOnly,
});

globalThis.checkValidJSON = function (csrfToken) {
  $.ajax({
    type: 'POST',
    url: `${ME_SETTINGS.baseHref}checkValid`,
    data: {
      document: addDoc.getValue(),
      _csrf: csrfToken,
    },
  }).done((data) => {
    if (data === 'Valid') {
      $('#documentInvalidJSON').remove();
      $('#addDocumentForm').submit();
    } else if ($('#documentInvalidJSON').length === 0) {
      $('#document-modal-body').parent().append('<div id="documentInvalidJSON" class="alert alert-danger"><strong>Invalid JSON</strong></div>');
    }
  });
  return false;
};

globalThis.checkValidIndexJSON = function (csrfToken) {
  $.ajax({
    type: 'POST',
    url: `${ME_SETTINGS.baseHref}checkValid`,
    data: {
      document: addIndexDoc.getValue(),
      _csrf: csrfToken,
    },
  }).done((data) => {
    if (data === 'Valid') {
      $('#indexInvalidJSON').remove();
      $('#addIndexForm').submit();
    } else if ($('#indexInvalidJSON').length === 0) {
      $('#index-modal-body').parent().append('<div id="indexInvalidJSON" class="alert alert-danger"><strong>Invalid JSON</strong></div>');
    }
  });
  return false;
};

$('#addDocument').on('shown.bs.modal', function () {
  addDoc.refresh();
  addDoc.focus();
});

$('#addIndex').on('shown.bs.modal', function () {
  addIndexDoc.refresh();
  addIndexDoc.focus();
});

if (ME_SETTINGS.collapsibleJSON) {
  $(function () {
    // convert all objects to renderjson elements
    $('div.tableContent pre').each(function () {
      const $this = $(this);
      const text = $.trim($this.text());
      if (text) {
        $this.html(renderjson(JSON.parse(text)));
      }
    });
  });
  renderjson.set_show_to_level(ME_SETTINGS.collapsibleJSONDefaultUnfold);
}

function makeCollectionUrl() {
  const st = ME_SETTINGS;
  return `${st.baseHref}db/${encodeURIComponent(st.dbName)}/${encodeURIComponent(st.collectionName)}/`;
}

globalThis.loadDocument = function (url) {
  const selection = globalThis.getSelection().toString();
  if (selection === '') {
    globalThis.location.href = url;
  }
};

function renderProp(input) {
  // Images inline
  if (
    typeof input === 'string'
    && (
      input.slice(0, 22) === 'data:image/png;base64,'
      || input.slice(0, 22) === 'data:image/gif;base64,'
      || input.slice(0, 22) === 'data:image/jpg;base64,'
      || input.slice(0, 23) === 'data:image/jpeg;base64,'
    )
  ) {
    return `<img src="${encode(input)}" style="max-height:100%; max-width:100%; "/>`;
  }

  // Audio inline
  if (
    typeof input === 'string'
    && (
      input.slice(0, 22) === 'data:audio/ogg;base64,'
      || input.slice(0, 22) === 'data:audio/wav;base64,'
      || input.slice(0, 22) === 'data:audio/mp3;base64,'
    )
  ) {
    return `<audio controls style="width:45px;" src="${encode(input)}">Your browser does not support the audio element.</audio>`;
  }

  // Video inline
  if (
    typeof input === 'string'
    && (
      input.slice(0, 23) === 'data:video/webm;base64,'
      || input.slice(0, 22) === 'data:video/mp4;base64,'
      || input.slice(0, 22) === 'data:video/ogv;base64,'
    )
  ) {
    const videoFormat = input.match(/^data:(.*);base64/)[1];
    return `<video controls><source type="${encode(videoFormat)}" src="${encode(input)}"/>
      + 'Your browser does not support the video element.</video>`;
  }
  if (typeof input === 'object' && (input.toString() === '[object Object]' || input.toString().slice(0, 7) === '[object')) {
    return renderjson(input);
  }

  // treat unknown data as escaped string
  return encode(input.toString());
}

$(() => {
  const $tableWrapper = $('.tableWrapper');
  if ($('.tableHeaderFooterBars').width() === $tableWrapper.width()) {
    // table wrapper is the same width as the table itself, so not overflowing, so remove the white gradient
    $('.fadeToWhite').remove();
  } else {
    $('.fadeToWhite').height($('.tableWrapper').height()); // limit the height only to the table div
  }

  $('.deleteButtonCollection').tooltip({
    title: 'Are you sure you want to delete this collection? All documents will be deleted.',
  });

  $tableWrapper.scroll(function () {
    const proximityToRightOfTable = $('.tableWrapper table').width() - $tableWrapper.scrollLeft() - $tableWrapper.width();
    const opacity = Math.min(Math.max(proximityToRightOfTable - 50, 50) - 50, 100) / 100;
    document.querySelector('#fadeToWhiteID').style.opacity = Math.min(opacity, 0.6);
  });

  $('.tooDamnBig').on('click', function (e) {
    e.preventDefault();
    e.stopPropagation();

    const target = $(this);
    const _id = target.attr('doc_id');
    const prop = target.attr('doc_prop');
    const spinner = `<img src="${ME_SETTINGS.baseHref}public/img/gears.gif" />`;
    const leftScroll = $tableWrapper.scrollLeft();

    // Set the element with spinner for now
    target.html(spinner);

    $.get(`${makeCollectionUrl()}${encodeURIComponent(_id)}/${prop}`, function (prop) {
      prop = renderProp(prop);
      // Set the element with gotten datas
      target.parent().html(prop);

      // Set original scroll position
      $('.tableWrapper').scrollLeft(leftScroll);
    });
  });

  $('.deleteButtonDocument').on('click', function (e) {
    const $form = $(this).closest('form');
    const $target = $('#confirm-deletion-document');
    e.stopPropagation();
    e.preventDefault();

    const modal = new Modal($target, { backdrop: 'static', keyboard: false });

    $target
      .one('click', '#delete', function () {
        $form.trigger('submit'); // submit the form
      });
    modal.show();
  });

  $('#deleteListConfirmButton').on('click', function () {
    // we just need to POST the form, as all the query parameters are already embedded in the form action
    $('#deleteListForm').trigger('submit');
  });

  $('.deleteButtonCollection').on('click', function (event) {
    $('.deleteButtonCollection').tooltip('hide');

    event.preventDefault();

    const $target = $('#confirm-deletion-collection');
    const $parentForm = $(this).parent();

    const modal = new Modal($target, { backdrop: 'static', keyboard: false });

    $('#confirmation-input').attr('shouldbe', $(this).data('collection-name'));
    $('#modal-collection-name').text($(this).data('collection-name'));
    $target
      .one('shown.bs.modal', function () {
        $('#confirmation-input').focus();
      })
      .one('click', '#deleteCollectionConfirmation', function () {
        const $input = $('#confirmation-input');
        if ($input.val().toLowerCase() === $input.attr('shouldbe').toLowerCase()) {
          $parentForm.trigger('submit');
        }
      });
    modal.show();
  });

  const nextSort = {
    1: -1,
    '-1': 0,
    0: 1,
    undefined: 1,
  };
  $('.sorting-button').on('click', function () {
    const $this = $(this);
    const column = $this.data('column');
    const direction = nextSort[$this.data('direction')];

    $('input.sort-' + column).val(direction).prop('checked', direction !== 0);

    $('#my-tab-content .tab-pane.active form').trigger('submit');
  });

  const $importInputsFile = $('.import-input-file');
  const $importFileLinks = $('.import-file-link');

  // Trigger onClick event on hidden input file
  $.each($importFileLinks, (key, link) => {
    $(link).on('click', function () {
      $($importInputsFile[key]).trigger('click');
    });
  });
  // When file is add in input, send it to the server
  $importInputsFile.on('change', function (event) {
    const { files } = event.target;
    const collection = $(event.target).attr('collection-name');
    const data = new FormData();

    $.each(files, (key, value) => {
      data.append(`file_${key}`, value);
    });

    const csrfToken = document.querySelector('[name="_csrf"]').value;

    $.ajax({
      type: 'POST',
      url: `${ME_SETTINGS.baseHref}db/${ME_SETTINGS.dbName}/import/${collection}`,
      data,
      cache: false,
      processData: false, // Don't process the files
      contentType: false, // Set content type to false as jQuery will tell the server its a query string request
      beforeSend: (request) => request.setRequestHeader('X-CSRF-TOKEN', csrfToken),
    })
      .done(function (res) {
        // eslint-disable-next-line no-alert
        alert(res);
        globalThis.location.reload();
      })
      .catch(function (error) {
        // eslint-disable-next-line no-alert
        alert(error?.responseText);
      });
  });
});
