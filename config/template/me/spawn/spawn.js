// TODO defer event callback updates w/in 1 second of a mouse move
// TODO implement page reload/refresh afer # events and # mouse idle time
(function() {

var initOnce = false,
    rpcAuth = '',
	filter = '',
	showHost = null,
	editing = null,
    clusterData = null,
	params = {},
	aliases = {},
	revAliases = {},
	jobs = {},
	hosts = {},
	groups = {},
	macros = {},
	macroList = [],
	macroEditKey = null,
	commands = {},
	commandList = [],
	sortColumn = {},
	zkStack = [],
	meshStack = [],
	meshLS = [],
	enablePolling = true,
	eventID = 1,
	eventPoller = null,
	// this timer runs when callbacks are temporarily disabled
	queuePoller = null,
	queuedEvents = [],
	lastJob = null,
	lastJoblist = null,
	lastHostlist = null,
	lastCmdlist = null,
	lastMacrolist = null,
	//this will store the filter functions for tables, each table rendered can have at most 1
	filterFunctions = {},
	lastLog = {},
	lastRender = {},
	tabs = ["commands","macros","jobs","hosts","alias","zk","mesh"],
    tabSetting = "spawn.tab",
	setup = {},
	scroll = {},
	db = localStorage || {},
	console = window.console || { log:function() { } },
	clientID = Math.floor(Math.random()*1000000),
	currentJob = {checked:{},respawn:false,nodes:[]},
	isCompact = navigator.userAgent.match(/iPad/i) != null || db['compact'] == 1 || db['compact'] == true,
	hostDomain = db['host.domain'] || '',
	lineWrap = db['line.wrap'] == 'true' || db['line.wrap'] == 1 || false,
	paramWrap = !(db['param.wrap'] == 'false' || db['param.wrap'] == 0) || isCompact,
	sizeK = 1024,
	sizeM = sizeK * 1024,
	sizeG = sizeM * 1024,
	sizeT = sizeG * 1024,
	form_config_editor = null,
	form_macro_editor = null,
	flowGraph=null,
	queued=0,
    spawnqueuesize=0,
    spawnqueueerrorsize=0,
	rpcRoot="http://localhost:5050";

function parse(json,defval) {
	try {
		return eval('('+json+')');
	} catch (e) {
		console.log(['parse error',json,e]);
		return defval;
	}
}

// ------------------------------------------------------------------------------------------
// Page Init / Entry Point
// ------------------------------------------------------------------------------------------

/* called on page load  */
function init() {
	try {
		if (initOnce)
		{
			return;
		}

        params = util.getUrlParamMap();
		if (params['nopoll']) {
			enablePolling = false;
		}
        if (params.cluster) {
            var clusterString = db['cluster-'+params.cluster];
            if (clusterString) {
                clusterData = JSON.parse(clusterString);
                if (!clusterData.isLocal && clusterData.proc.spawn) {
                    rpcRoot = "http://"+util.firstKey(clusterData.proc.spawn)+":5050"
                }
                rpcAuth = clusterData.authKey;
                $('status_cluster').innerHTML = clusterData.about;
            }
        }
        var forms = document.getElementsByTagName('form');
        for (var i=0; i<forms.length; i++) {
            var act = forms[i].action;
            forms[i].action = rpcRoot + act.substring(act.indexOf("/XXX")+4) + "?auth=" + rpcAuth + "&user=" + getUser();
        }
		showTab(db[tabSetting] || 'jobs');
		checkUser();
		if (db[db[tabSetting]+'filter']) {
			filter = db[db[tabSetting]+'filter'];
			$('form_filter').value = filter;
		}
		for (var i=0; i<db.length; i++) {
			var key = db.key(i);
			if (key.indexOf("spawn.sort_col_") == 0) {
				sortColumn[key.substring(15)] = db[key];
			}
		}
        $('job_log_lines').value = db['spawn.log_lines'] || 50;
		refresh();
		eventPollSetup();
		if (db['zkPath']) {
			zkStack = db['zkPath'].split('/');
			getZk();
		} else {
			zkTruncate(0);
		}
		meshTruncate(0);
		// code mirror ftw
		if (!form_config_editor) form_config_editor = CodeMirror($('code_config'), {lineWrapping:lineWrap, mode:{name:"javascript",json:true}});
		if (!form_macro_editor) form_macro_editor = CodeMirror($('code_macro'), {lineWrapping:lineWrap, mode:{name:"javascript",json:true}});
		// there can be only one
		initOnce = true;
	} catch (e) {
		console.log(['init',e]);
	}
}

function refreshEditText(cm) {
	cm.setValue(cm.getValue());
}

function safeCall(func,a,b,c) {
	try {
		func(a,b,c);
	} catch (e) {
		console.log(['fail call', e, a,b,c, func]);
	}
}

/** for capturing ESC and TAB in text areas */
function captureKey(o,e) {
	if (e.keyCode == 9) {
		if (e.altKey) {
			o.value = o.value.replace('    ','\t');
		} else {
			insertText(o,'\t');
		}
		return false;
	}
	if (e.keyCode == 27 || (e.keyCode == 13 && e.altKey && (e.metaKey || e.ctrlKey))) {
		o.blur();
		return false;
	}
}

/** textedit <TAB> helper */
function insertText(el,txt) {
	var o = $(el);
	var start = o.selectionStart;
	var end = o.selectionEnd;
	var scrollTop = o.scrollTop;
	var len = txt.length;
	o.value = o.value.substring(0, start)+txt+o.value.substring(end,o.value.length);
	o.focus();
	o.selectionStart = start + len;
	o.selectionEnd = start + len;
	o.scrollTop = scrollTop;
}

function windowKeyDown(evt) {
	if (evt.srcElement.tagName == 'INPUT' || evt.srcElement.tagName == 'TEXTAREA') {
		return;
	}
	switch (evt.keyCode)
	{
		case 8: if (db[tabSetting] == 'jobs') { deleteJob(db['spawn.job_show']); evt.stopPropagation(); return false; } break;
		case 27: if (editing) { showEdit(editing,false); evt.stopPropagation(); return false; } break; // esc to close edit window
	}
}

function windowKeyPress(evt) {
	//console.log([evt]);
	if (evt.srcElement.tagName == 'INPUT' || evt.srcElement.tagName == 'TEXTAREA') {
		return;
	}
	if (evt.altKey || evt.ctrlKey || evt.metaKey) {
		return;
	}
	switch (evt.keyCode)
	{
		case 8: evt.stopPropagation(); return false;
		case 63: alert(['magic keys:','c = command tab','m = macro tab','j = job tab','h = host tab','r = refresh spawn ui','t = toggle quiesce','e = edit job','s = stop job','k = (re)kick job','DEL = delete job'].join('\n')); break // ? for help
		case 97: showTab('alias'); break; // 'a'
		case 99: showTab('commands'); break; // 'c'
		case 109: showTab('macros'); break; // 'm'
		case 106: showTab('jobs'); break; // 'j'
		case 104: showTab('hosts'); break; // 'h'
		case 122: showTab('zk'); break; // z
		case 114: refresh(); break; // 'r'
		case 116: toggleQuiesce(); break; // t
		case 101: if (db[tabSetting] == 'jobs') editJob(db['spawn.job_show']); break; // e
		case 113: if (db[tabSetting] == 'jobs') toggleQuiesce(); break; // 'q' (TODO open query winow -- http://'+setup.queryHost+'/query/index.html?job='+job.id)
		case 115: if (db[tabSetting] == 'jobs') stopJob(db['spawn.job_show'],0); break; // s
		case 107: if (db[tabSetting] == 'jobs') rekickJob(db['spawn.job_show']); break; // k
	}
}

// ------------------------------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------------------------------

function getJob(id) {
	return jobs[id];
}

function getTask(job,task) {
	var job = getJob(job);
	return (job && job.nodes) ? job.nodes[task] : null;
}

function jsonp(url) {
	old = $('jsonpscript');
	if (old != null) {
		old.parentNode.removeChild(old);
	}
	var head = document.getElementsByTagName("head")[0];
	var script = document.createElement('script');
	script.id = 'jsonpscript';
	script.type = 'text/javascript';
	script.src = url;
	head.appendChild(script);
}

function callRPC(path, callback, options) {
    if (!options) options = {};
    jQuery.ajax({
        url: (options.host || rpcRoot) + path,
        type: "GET",
        crossDomain: true,
        data: {
            user: getUser(),
            auth: rpcAuth
        },
        dataType: "json",
        success: function (response) {
            if (callback) {
                callback(response);
            } else {
                console.log(['OK -->', path, options]);
            }
        },
        error: function (xhr, status) {
            console.log(['ERR -->', path, options, xhr, status]);
        }
    });
}

/* alerts on a failed rpc */
function rpcCallback(data) {
	//console.log(['rpc callback',data]);
}

function sortTable(id, col) {
	sortColumn[id] = sortColumn[id] && sortColumn[id] == Math.abs(col) ? 0 - sortColumn[id] : col;
	db['spawn.sort_col_'+id] = sortColumn[id];
	renderTable(id);
}

/* render and tag a table tied to an object */
/* table.id = string : dom id
        .label = array : strings to describe columns
		.labeladd = array : strings to add to column cell definition
		.rows = array of array of strings
		.rowadd = array : strings to add to row column cell definitions
		.rowon = int : starting row for rendering
		.rowoff = int : ending row for rendering
		.allscroll = boolean : entire area response to mouse wheel
*/
function renderTable(id,table,scrolling,addclass) {
	if (!table && lastRender[id]) {
		table = lastRender[id][0];
		scrolling = lastRender[id][1];
		addclass = lastRender[id][2];
	} else {
		lastRender[id] = [table, scrolling, addclass];
	}
	table.rowon = table.rowon || 0;
	table.rowoff = Math.min(table.rowoff || table.rows.length, table.rows.length);
	if (!scrolling && db[table.id+'-rowon']) {
		var diff = table.rowoff - table.rowon;
		table.rowon = parseInt(db[table.id+'-rowon']);
		table.rowoff = table.rowon + diff;
	}
	if (table.rowoff > table.rows.length) {
		var diff = table.rowoff - table.rowon;
		table.rowon = 0;
		table.rowoff = diff;
	}
	var scrollid = "sb"+table.id;
	var tableclass = ["render", scrollid];
	if (addclass) {
		tableclass.push(addclass);
	}
	if (sortColumn[id]) {
		var dir = 1;
		var idx = sortColumn[id];
		if (idx < 0) {
			idx = 0 - idx;
			dir = -1;
		}
		table.rows.sort(function(a,b) {
			try {
				var va = a[idx-1] || '';
				var vb = b[idx-1] || '';
				var toa = typeof(va);
				var tob = typeof(vb);
				if (toa == 'object') {
					va = va[1];
					toa = typeof(va);
				}
				if (tob == 'object') {
					vb = vb[1];
					tob = typeof(vb);
				}
				if (toa != tob) {
					if (toa == 'number') return 1 * dir;
					if (tob == 'number') return -1 * dir;
					return 0;
				}
				if (toa == 'number' && tob == 'number') {
					return (va - vb) * dir;
				}
				if (va.match(/^[0-9,]+$/) || vb.match(/^[0-9,]+$/)) {
					var na = parseInt(va.replace(/,/g,'')) || 0;
					var nb = parseInt(vb.replace(/,/g,'')) || 0;
					return (na - nb) * dir;
				}
				var sa = va.replace(/<[^>]*>/g,"");
				var sb = vb.replace(/<[^>]*>/g,"");
				return (sa == sb ? 0 : sa > sb ? 1 : -1) * dir;
			} catch (e) {
				console.log([e,idx,a,b]);
				return 0;
			}
		});
	}
    var src = ['<div>'];
    if (table.title) {
        src.push('<div class="table-title">');
        src.push(table.title);
        src.push('</div>');
    }
	src.push('<div><table height="100%" id="'+table.id+'"'+(table.allscroll ? ' class="'+tableclass.join(' ')+'"' : 'id=1')+'><thead><tr>');
	for (var i=0; i<table.label.length; i++) {
		var ladd = (table.labeladd && table.labeladd.length >= i) ? " "+table.labeladd[i] : '';
		src.push('<th'+ladd+'><a href="#" onclick="Spawn.sortTable(\''+id+'\','+(i+1)+')">'+table.label[i]+'</a></th>');
	}
    src.push('<th></th>');
    src.push('</tr></thead><tbody>');
	for (var i=table.rowon; i<table.rowoff; i++) {
		var row = table.rows[i] || [];
        src.push('<tr class="'+(i%2?"row_odd":"row_even")+'">');
		for (var j=0; j<row.length; j++) {
			var radd = (table.rowadd && table.rowadd.length >= j) ? " "+table.rowadd[j] : '';
			var cval = typeof(row[j]) != 'object' ? row[j] : row[j][0];
            src.push('<td'+radd+'>'+cval+'</a></td>');
		}
		if (i == table.rowon && (table.rowon > 0 || table.rowoff < table.rows.length)) {
			var len = table.rows.length;
			var height = table.rowoff - table.rowon;
			var pbefore = (table.rowon > 0 ? table.rowon / len : 0) * 100;
			var pheight = (height / len) * 100;
			var pafter = (100.0 - (pbefore + pheight));
			var divs = '<table height="100%" class="scroll_area" border=0 cellspacing=0 cellpadding=0>';
			divs += '<tr><td height="'+pbefore+'%"></td></tr>';
			divs += '<tr><td height="'+pheight+'%" style="background-color:#88d">&nbsp;</td></tr>';
			divs += '<tr><td height="'+pafter+'%"></td></tr>';
			divs += '</table>';
            src.push('<td class="col_scoll" id="'+scrollid+'" align="center" rowspan="'+height+'" height="100%" valign="middle">'+divs+'</td>');
		}
        src.push('</tr>');
	}
	scroll[scrollid] = function(delta) {
 		if (delta > 0 && delta < 1) {
			delta = 1;
		} else if (delta < 0 && delta > -1) {
			delta = -1;
		} else {
			delta = Math.round(delta);
            delta = delta * delta * (delta > 0 ? 1 : -1);
		}
		var maxwin = table.rowoff - table.rowon;
		var maxlen = table.rows.length;
		table.rowon = Math.max(0,table.rowon - delta);
		if (table.rowon + maxwin > maxlen) {
			table.rowon = maxlen - maxwin;
		}
		table.rowoff = table.rowon + maxwin;
		if (db[table.id+'-rowon'] != table.rowon) {
			db[table.id+'-rowon'] = table.rowon;
			renderTable(id,table,true,addclass);
		}
	};
    src.push('</tbody></table></div>');
	$(id).innerHTML =  src.join('');
	if(table.filterFunction){
		filterFunctions[table.id] = table.filterFunction;
	}
}

/* two-cell table for split columns -- host table */
function twocell(l,r) {
	return '<table class="lrtable"><tr><td>'+l+'</td><td>'+r+'</tr></table>';
}

/* show or hide a div */
function showHide(e,b) {
	$(e).style.display = b ? 'block' : 'none';
}

/* show or hide a div. track last showed for <ESC> hiding.  */
function showEdit(e,b) {
	$(e).style.display = b ? 'block' : 'none';
	if (b) {
		editing = e;
        setPollerQueue(null, true);
	} else {
		editing = null;
        setPollerLive();
	}
}

/* handle wheel delta signal */
function wheelDelta(delta,obj,event) {
	var cn = null;
	if (obj.className) {
		var cna = obj.className.toString().split(' ');
		if (cna.length > 1) {
			cn = cna[1];
		}
	}
	var oid = (obj.id && scroll[obj.id]) ? obj.id : (cn && scroll[cn]) ? cn : null;
	if (oid) {
		scroll[oid](delta);
		event.returnValue = false;
		event.cancelBubble = true;
		if (event.stopPropagation) {
			event.stopPropagation();
		}
		if (event.preventDefault) {
			event.preventDefault();
		}
	} else if (obj.parentNode) {
		wheelDelta(delta,obj.parentNode,event);
	}
}

var startTouchY = null;
var lastTouchOffset = null;

/* iDevice scrolling */
function touchStart(event) {
	startTouchY = event.touches.item(0).clientY;
	lastTouchOffset = 0;
}

/* iDevice scrolling */
function touchMove(event) {
//	console.log(['touch move', event.type, event.touches, event.target]);
	if (event.touches) {
		var touch = event.touches.item(0);
		var touchOffset = (touch.clientY - startTouchY) / 10;
		wheelDelta(touchOffset - lastTouchOffset, touch.target, event);
		lastTouchOffset = touchOffset;
	}
}

/* handle mouse wheel */
function wheelHandle(event) {
	var delta = 0;
	if (!event) {
		event = window.event;
	}
	if (event.wheelDelta) {
		delta = event.wheelDelta/120;
		if (window.opera) {
			delta = -delta;
		}
	} else if (event.detail) {
		delta = -event.detail/3;
	}
	if (delta) {
		wheelDelta(delta,event.target,event)
	}
}

/* show selected tab (and hide others) */
function showTab(tab) {
	var tab_dom = 'tab_'+tab;
	var tab_btn = 'btn_'+tab;

	$('form_filter').value = db[tab+'filter'] || '';//set the new tab filtering value
	filter = $('form_filter').value;
	db[tabSetting] = tab; //save the new tab selection
	for (var i=0; i<tabs.length; i++) {
		var dom = 'tab_'+tabs[i];
		var btn = 'btn_'+tabs[i];
		if (!$(dom) || !$(btn)) {
			continue;
		}
		if (tab_dom != dom) {
			$(dom).style.display = 'none';
		} else {
			$(dom).style.display = 'block';
		}
	}
}

/* called when node checkbox is toggled */
function dropHost(uuid) {
	callRPC("/host.delete?uuid="+uuid);
}

/* rebalance a host */
function rebalanceHost(uuid) {
	if (confirm('rebalance host '+uuid+'?')) {
		window.open('/host.rebalance?uuid='+uuid);
	}
}

function hostFailInfo(uuid, deadFs) {
	callRPC("/host.fail.info?uuids="+uuid + "&deadFs=" + deadFs, hostFailInfoCallback);
}

function hostFailInfoCallback(data) {
	uuids = data.uuids;
	if (data.fatal) {
		alert("WARNING! Spawn says failing " + uuids + " means " + data.fatal);
	}
	var msg = "Are you sure you want to fail " + uuids + "?\n";
	msg += "Cluster will go from " + fpercent(data.prefail) + "% disk used to " + fpercent(data.postfail) + "%.\n";
	if (data.warning) {
		msg += "Warning: " + data.warning;
	}
	if (confirm(msg)) {
		failHost(uuids, data.deadFs)
	}
}

/* danger, danger */
function failHost(uuid, deadFs) {
    callRPC("/host.fail?uuids="+uuid+"&deadFs="+(deadFs ? 1 : 0));
}

function cancelHostFail(uuid) {
	callRPC("/cancel.host.fail?uuids="+uuid);
}

function enableHost(hosts) {
	if (confirm('are you sure want to enable '+hosts+' ?')) {
        callRPC("/host.enable?hosts="+hosts);
	}
}

function disableHost(hosts) {
	if (confirm('are you sure you want to disable '+hosts+' ?')) {
        callRPC("/host.disable?hosts="+hosts);
	}
}

/* called when node checkbox is toggled */
function selectHost(checkbox, uuid) {
	currentJob.checked[uuid] = checkbox.checked;
}

/* called when node group checkbox is toggled */
function selectHostGroup(checkbox, group) {
	var groupHosts = groups[group];
	var check = !$('ck_'+groupHosts[0][0]).checked;
	for (var i=0; i<groupHosts.length; i++) {
		var host = groupHosts[i];
		selectHost(check, host[0]);
		$('ck_'+host[0]).checked = check;
	}
}

/* format number with comma separators */
function fnum(n,compact) {
	if (!n || n == 0) {
		return n;
	}
	var post = '';
	if (compact) {
		if (n > sizeT) {
			n = Math.round(n / sizeG);
			post = 'G';
		} else if (n > sizeG) {
			n = Math.round(n / sizeM);
			post = 'M';
		} else if (n > sizeM) {
			n = Math.round(n / sizeK);
			post = 'K';
		}
	}
	var pre = n < 0 ? "-" : "";
	var x = 1000;
	var a = [];
	n = Math.abs(n);
	while (n != 0) {
		var d = n % x;
		a.push(d/(x/1000));
		n -= d;
		x *= 1000;
	}
	a = a.reverse();
	for (var i=1; i<a.length; i++) {
		a[i] = a[i].toString();
		a[i] = '000'.substring(a[i].length)+a[i];
	}
	return pre+a.join(",")+post;
}

function fpercent(v) {
	if (v) {
		return Math.round(100 * v);
	}
	return '';
}

/* format date nice and pretty */
function fsdate(v) {
    if (v) {
        var d = new Date();
        d.setTime(v);
        return d.toString('MM/dd HH:mm');
    }
    return '';
}

function fdate(v) {
    return '&nbsp;'+fsdate(v)+'&nbsp;';
}

/* set spawn poller to queueing mode */
function setPollerQueue(evt,disable) {
	if (queuePoller != null) {
		clearTimeout(queuePoller);
		queuePoller = null;
	}
    if (disable === true) {
        enablePolling = false;
        $('event_count').innerHTML = 'paused';
    }
	if (enablePolling) {
		try {
    		queuePoller = setTimeout(setPollerLive, 500);
            $('event_count').innerHTML = 'queueing';
		} catch (e) { }
	}
}

/* set spawn poller to live mode */
function setPollerLive() {
    enablePolling = true;
	if (queuePoller != null) {
		clearTimeout(queuePoller);
		queuePoller = null;
		$('event_count').innerHTML = 'live';
		if (queuedEvents.length > 0) {
			var qev = queuedEvents;
			queuedEvents = [];
			for (var i=0; i<qev.length; i++) {
				eventUpdater(qev[i]);
			}
		}
	}
}

function eventPollSetup() {
	if (enablePolling && eventPoller == null) {
		eventPoller = callRPC('/listen.batch?call='+(eventID++)+'&clientID='+clientID+'&timeout=10000', eventPollCallback);
	}
}

function eventPollCallback(obj,topic) {
	eventPoller = null;
	eventPollSetup();
    if (Array.isArray(obj)) {
        eventUpdater(eventHandler("event.batch", obj));
    } else {
        eventUpdater(eventHandler(topic, obj));
    }
}

function eventUpdater(update) {
	// if there is a poller running or events are disabled, push to queue
	if (queuePoller != null) {
		queuedEvents.push(update);
		$('event_count').innerHTML = 'queued '+queuedEvents.length;
		return;
	}
	var add = 0;
	if (update.hosts) {
		renderHosts();
		add = 1;
	}
	if (update.jobs) {
		renderJobs();
		add = 1;
	}
	Spawn.events = (Spawn.events || 0) + add;
	$('event_count').innerHTML = Spawn.events+" / "+(Spawn.eventsBatch || 0);
}

function eventHandler(label,obj,merge) {
	var update = merge || {};
	switch (label) {
		default:
			break;
		case 'event.batch':
			Spawn.eventsBatch = (Spawn.eventsBatch || 0) + obj.length;
			for (var i=0; i<obj.length; i++) {
				var msg = obj[i];
				update = eventHandler(msg.topic, msg.message, update);
			}
			break;
		case 'host.update':
			if (hosts[obj.uuid]) {
				hosts[obj.uuid] = obj;
				for (var i=0; i<lastHostlist.length; i++) {
					if (lastHostlist[i].uuid == obj.uuid) {
						lastHostlist[i] = obj;
						break;
					}
				}
			} else {
				lastHostlist.push(obj);
				hosts[obj.uuid] = obj;
			}
			update.hosts = true;
			break;
		case 'host.delete':
			if (hosts[obj.uuid]) {
				delete hosts[obj.uuid];
				for (var i=0; i<lastHostlist.length; i++) {
					if (lastHostlist[i].uuid == obj.uuid) {
						lastHostlist.splice(i,1);
						break;
					}
				}
				update.hosts = true;
			}
			break;
		case 'job.update':
			if (jobs[obj.id]) {
				if (lastJob && lastJob.id == obj.id) {
					// force nodes refresh for jobs currently selected
					lastJob = null;
				}
				jobs[obj.id] = obj;
				for (var i=0; i<lastJoblist.length; i++) {
					if (lastJoblist[i].id == obj.id) {
						lastJoblist[i] = obj;
						break;
					}
				}
			} else {
				jobs[obj.id] = obj;
				lastJoblist.push(obj);
			}
			update.hosts = true;
			update.jobs = true;
			break;
		case 'job.delete':
			if (jobs[obj.id]) {
				delete jobs[obj.id];
				for (var i=0; i<lastJoblist.length; i++) {
					if (lastJoblist[i].id == obj.id) {
						lastJoblist.splice(i,1);
						break;
					}
				}
				update.hosts = true;
				update.jobs = true;
			}
			break;
		case 'task.queue.size':
			spawnQueueSizeCallback(obj);
			break;
	}
	return update;
}

/* refresh rpc locally cached objects from server */
function refresh() {
	callRPC('/setup?all=1', setupCallback);
	getAliases();
}

function checkUser() {
    if (!db['iam']) {
        setUser();
    }
}

function getUser() {
    return db['iam'];
}

function setUser() {
    db['iam'] = prompt('Provide User Name',db['iam']) || db['iam'];
    checkUser();
}

function setAuth() {
    rpcAuth = prompt('Provide Spawn Auth Key',rpcAuth) || rpcAuth;
    refresh();
}

function setHost() {
    rpcRoot = prompt('Provide Spawn HTTP Root',rpcRoot) || rpcRoot;
    refresh();
}

/* stop or restart job scheduling */
function toggleQuiesce() {
	if (confirm((setup.quiesce?"un":"")+"quiesce the cluster? (if you don't know what you're doing, hit cancel!)")) {
		callRPC('/setup?quiesce='+(setup.quiesce?0:1), setupCallback);
		setPollerLive();
	}
}

/* AJAX & CALLBACK from spawn_init(): fetch spawn setup data (quiesce and debug) */
function setupCallback(newSetup) {
    setup = newSetup;
	$('quiesce').innerHTML = setup.quiesce ? 'Reactivate' : 'Quiesce';
    $('top').setStyle(setup.quiesce ? {'background':'#fdd'} : {'background':'#eee'});
	setJoblist(setup.jobs);
	setHostlist(setup.hosts);
	lastMacrolist = setup.macros;
	lastCmdlist = setup.commands;
	if (setup.hosts) renderHosts();
	if (setup.jobs) renderJobs();
	if (setup.macros) renderMacros();
	if (setup.commands) renderCommands();
}

function setJoblist(joblist) {
	if (!joblist) {
		return;
	}
	var newjobs = {};
	for (var i=0; i<joblist.length; i++) {
		var job = joblist[i];
		newjobs[job.id] = job;
	}
	jobs = newjobs;
	lastJoblist = joblist;
}

function setHostlist(hostlist) {
	if (!hostlist) {
		return;
	}
	var newhosts = {};
	for (var i=0; i<hostlist.length; i++) {
		var host = hostlist[i];
		if (!host.host) {
			continue;
		}
		newhosts[host.id] = host;
	}
	hosts = newhosts;
	lastHostlist = hostlist.sort(function(a,b) { return a.host > b.host ? 1 : -1; });
}

// ------------------------------------------------------------------------------------------
// VFS Browsers
// ------------------------------------------------------------------------------------------

function formatData(data, div) {
    if (data == null) {
        $(div).innerHTML = '';
        return;
    }
    if (typeof data == 'object') {
        if (data.message) {
            $(div).innerHTML = '<div style="font-family:monospace">'+data.message+'</div>';
            return;
        }
        data = JSON.stringify(data,null,3);
    }
    $(div).innerHTML = prettyPrintOne(data,"js");
}

// ------------------------------------------------------------------------------------------
// Mesh Browser
// ------------------------------------------------------------------------------------------

function meshTruncate(size) {
	if (size < meshStack.length) {
		meshStack = meshStack.slice(0,size);
	}
	getMesh();
}

function meshPush(index) {
	meshStack.push(meshLS[index]);
	getMesh();
}

function getMesh() {
	var path = meshStack.length > 0 ? meshStack[meshStack.length-1] : {name:''};
    var renderPath = '<a href="#" onclick="Spawn.meshTruncate(0)">...</a>';
    for (var i=0; i<meshStack.length; i++) {
        var name = meshStack[i].name.split('/');
        renderPath += ' / <a href="#" onclick="Spawn.meshTruncate('+(i+1)+')">'+name[name.length-1]+'</a>';
    }
	$('mesh_path').innerHTML = renderPath;
	callRPC('/mesh.ls?path='+path.name+'/*', getMeshLsCallback);
	if (path.uuid) {
        callRPC('/mesh.get?path='+path.name+'&uuid='+path.uuid, getMeshGetCallback);
    } else {
        $('mesh_value').innerHTML = '';
    }
}

function getMeshLsCallback(newMeshLS) {
	meshLS = newMeshLS || meshLS;
	newMeshLS.sort(function(a,b) {
		return a.name > b.name ? 1 : -1;
	});
	var renderList = '<table>';
	for (var i=0; i<meshLS.length; i++) {
        var name = meshLS[i].name.split('/');
		renderList += '<tr><th>'+meshLS[i].uuid+'</th><td><a href="#" onclick="Spawn.meshPush('+i+')">'+name[name.length-1]+'</a></td></tr>';
	}
	$('mesh_children').innerHTML = renderList+'</table>';
}

function getMeshGetCallback(data) {
    formatData(data,'mesh_value');
}

// ------------------------------------------------------------------------------------------
// ZooKeeper Browser
// ------------------------------------------------------------------------------------------

function zkTruncate(size) {
	if (size < zkStack.length) {
		zkStack = zkStack.slice(0,size);
	}
	getZk();
}

function zkPush(token) {
	zkStack.push(token);
	getZk();
}

function getZk() {
	var renderPath = '<a href="#" onclick="Spawn.zkTruncate(0)">...</a>';
	for (var i=0; i<zkStack.length; i++) {
		renderPath += ' / <a href="#" onclick="Spawn.zkTruncate('+(i+1)+')">'+zkStack[i]+'</a>';
	}
	$('zk_path').innerHTML = renderPath;
	var path = zkStack.join('/');
	db['zkPath'] = path;
	callRPC('/zk.ls?path=/'+path, getZkLsCallback);
	callRPC('/zk.get?path=/'+path, getZkGetCallback);
}

function getZkLsCallback(o) {
	var renderList = '';
	for (var i=0; i<o.length; i++) {
		renderList += '<a href="#" onclick="Spawn.zkPush(\''+o[i]+'\')">'+o[i]+'</a><br>';
	}
	$('zk_children').innerHTML = renderList;
}

function getZkGetCallback(data) {
    formatData(data,'zk_value');
}

// ------------------------------------------------------------------------------------------
// Command Management
// ------------------------------------------------------------------------------------------

function getCommands() {
	callRPC('/command.list', renderCommands);
}

function fillFormsFromCommand(key) {
	var cmd = key ? commands[key] : {label:'',command:[]};
	$('form_command_owner').value = getUser();
	$('form_command_label').value = key || '';
	$('form_command_list').value = cmd.command.join('\n');
}

/* pass job data to new job tab and switch context */
function newCommand() {
	editCommand(null);
}

/* pass job data to new job tab and switch context */
function editCommand(key) {
	fillFormsFromCommand(key);
	showEdit('command_edit',true);
}

function storeCommand(id) {
	var cmd = $('form_command_list').value;
	$('send_command_list').value = cmd.split('\n').join(',');
	showEdit('command_edit',false);
	setTimeout(init, 500);
}

/* AJAX call spawn to delete command */
function deleteCommand(label) {
	if (confirm("delete command "+label+" ?")) {
		callRPC('/command.delete?label='+encodeURIComponent(label)+"&owner="+getUser(), function(rpc) { rpcCallback(rpc); getCommands(); });
	}
	return false;
}

/* AJAX CALLBACK from getConfig() that renders the node table */
function renderCommands(newCmdlist) {
	var filter = new ColumnFilter(["label","command"]);
    lastCmdlist = newCmdlist || lastCmdlist;
	commands = lastCmdlist;
	commandList = [];
	var commandsFilter = db['commandsfilter'] || '';
	filter.setFilterValue(commandsFilter);
	var table = {
		allscroll:true,
		id:"table_commands", 
		label:["command","uses","command","delete"],
		rowadd:['nowrap','align="center"','width=100%','align="center"'],
		rows:[],
		rowon:0,
		rowoff:16,
		filterFunction: renderCommands,
	};
	var cmduse = {};
	for (var key in jobs) {
		var job = jobs[key];
		if (cmduse[job.command]) {
			cmduse[job.command].push(key);
		} else {
			cmduse[job.command] = [key];
		}
	}
	var html = '';
	for (var key in commands) {
		var command = commands[key];
		if (commandsFilter.length > 0)
        {
            // restrict list to those containing a filter match
            if(!filter.match({label: key, command: command.command.join(' ')})){
                continue;
            }
        }

		command.jobs = cmduse[key] || [];
		commandList.push(key);
		html += '<option value="'+key+'">'+key+'</option>';
		table.rows.push([
			'<a href="#" title="edit" onclick="Spawn.editCommand(\''+key+'\')">'+key+'</a>',
            '<a href="#" title="edit" onclick="Spawn.showCommandJobs(\''+key+'\')">'+command.jobs.length+'</a>',
			command.command.join(' '),
			'<a href="#" title="delete" onclick="Spawn.deleteCommand(\''+key+'\'); return false;">X</a>',
		]);
		$('select_job_command').innerHTML = html;
	}
	renderTable('commands_list', table);
	showCommandJobs(db['showCommand']);
	window.Spawn.commands = commands;
}

/* render jobs associated with a command */
function showCommandJobs(command) {
	if (!command) {
		return;
	}
	$('command_jobs').innerHTML = "---";
	db['showCommand'] = command;
	var table = {
		allscroll:true,
		id:"table_command_jobs", 
		label:["job","description"],
		labeladd:[,,],
		rowadd:['nowrap','nowrap'],
		rows:[],
		rowon:0,
		rowoff:16,
        title:"Jobs using '"+command+"' command"
	};
	var joblist = commands[command].jobs;
	for (var i=0; i<joblist.length; i++) {
		var job = getJob(joblist[i]);
		table.rows.push([
			'<a href="#" onclick="Spawn.showJobDetail(\''+job.id+'\',true);Spawn.showTab(\'jobs\')">'+job.id+'</a>',
			job.description
		]);
	}
	renderTable('command_jobs', table, false);
	showHide('command_jobs', true);
}

// ------------------------------------------------------------------------------------------
// Alias Management
// ------------------------------------------------------------------------------------------

function getAliases() {
	callRPC('/alias.list?', getAliasesCallback);
}

function getAliasesCallback(newAliases) {
    aliases = newAliases || aliases;
	revAliases = {};
	for (var key in aliases) {
		var list = aliases[key];
		for (var i=0; i<list.length; i++) {
			revAliases[list[i]] = key;
		}
	}
	safeCall(renderAliases);
}

function fillFormsFromAlias(key) {
	var alias = key ? aliases[key] : [];
	$('form_alias_alias').value = key;
	$('form_alias_jobs_edit').value = (alias || []).join('\n');
}

function newAlias() {
	fillFormsFromAlias(null);
	showEdit('alias_edit',true);
}

function editAlias(key) {
	fillFormsFromAlias(key);
	showEdit('alias_edit',true);
}

function storeAlias(key) {
	showEdit('alias_edit',false);
	$('form_alias_jobs').value = $('form_alias_jobs_edit').value.split('\n').join(',');
	setTimeout(getAliases, 500);
}

function deleteAlias(key) {
	if (confirm('are you sure you want to delete the alias for "'+key+'"?')) {
		callRPC('/alias.delete?alias='+key, rpcCallback);
		setTimeout(getAliases, 500);
	}
}

function renderAliases() {
	var filter = new ColumnFilter(["alias","jobs"]);
	var table = {
		allscroll:true,
		id:"table_alias", 
		label:["alias","jobs"],
		rowadd:['nowrap','nowrap'],
		rows:[],
		rowon:0,
		rowoff:16,
		filterFunction: renderAliases
	};
	var aliasFilter = db['aliasfilter'] || '';
	filter.setFilterValue(aliasFilter);
	var index = 0;
	for (var key in aliases) {
		// if( (key+aliases[key].join('')).toLowerCase().indexOf(aliasFilter.toLowerCase()) >= 0 )
		if(filter.match({alias: key, jobs: aliases[key].join(",")}))
		{
			table.rows.push([
				'<a href="#" title="edit" onclick="Spawn.editAlias(\''+key+'\')">'+key+'</a>',
				aliases[key].join(', '),
				'<a href="#" title="delete" onclick="Spawn.deleteAlias(\''+key+'\'); return false;">X</a>',
			]);
		}		
	}
	sortColumn['alias_list'] = sortColumn['alias_list'] || 1; //by default, sort alphabetically
	renderTable('alias_list', table);
}

// ------------------------------------------------------------------------------------------
// Macro Management
// ------------------------------------------------------------------------------------------

function getMacros() {
	callRPC('/macro.list?', renderMacros);
}

function fillFormsFromMacro(key) {
	var macro = key ? macros[key] : {label:'',body:[]};
	$('form_bounce_target').value = '';
	$('form_macro_owner').value = getUser();
	$('form_macro_label').value = key || '';
	$('form_macro_desc').value = macro.description || '';
	form_macro_editor.setValue(macro.macro || '');
}

/* pass job data to new job tab and switch context */
function newMacro() {
	editMacro(null);
}

/* pass job data to new job tab and switch context */
function editMacro(key) {
	if (key != null) {
		macroEditKey = key;
		callRPC("/macro.get?label="+key, editMacroCallback);
	} else {
		fillFormsFromMacro(null);
		showEdit('macro_edit',true);
		refreshEditText(form_macro_editor);
	}
}

function editMacroCallback(macro) {
	macros[macroEditKey] = macro;
	fillFormsFromMacro(macroEditKey);
	showEdit('macro_edit',true);
	refreshEditText(form_macro_editor);
}

function storeMacro(key) {
	showEdit('macro_edit',false);
	$('form_macro_body').value = form_macro_editor.getValue();
	if ($('form_bounce_target').value != '') {
		var action = 'http://'+$('form_bounce_target').value+'/macro.put';
		$('form_macro_put').action = action;
	}
	setTimeout(getMacros, 500);
}

/* AJAX CALLBACK from getConfig() that renders the node table */
function renderMacros(newMacrolist) {
	var filter = new ColumnFilter(["label","description","owner"]);
	macros = newMacrolist || lastMacrolist;
	macroList = [];
	var macrosFilter=db['macrosfilter'] || '';
	filter.setFilterValue(macrosFilter);
	var table = {
		allscroll:true,
		id:"table_macros",
		label:["macro","description","owner","edited","delete"],
		rowadd:['nowrap','width=100% nowrap',,'align="center" nowrap','align="center"'],
		rows:[],
		rowon:0,
		rowoff:16,
		filterFunction: renderMacros,
	};
	var index = 0;
	for (var key in macros) {
		if (macrosFilter.length > 0)
        {
            // restrict list to those containing a filter match     
            if(!filter.match({label: key, description: macros[key].description, owner: macros[key].owner}))
            {
                continue;
            }
        }
		var macro = macros[key];
		macroList.push(key);
		macro.index = index++;
		table.rows.push([
			'<a href="#" title="edit" onclick="Spawn.editMacro(\''+key+'\')">'+key+'</a>',
			macro.description,
			macro.owner,
			[fdate(macro.modified), macro.modified],
			'<a href="#" title="delete" onclick="Spawn.deleteMacro(\''+key+'\'); return false;">X</a>',
		]);
	}
	renderTable('macros_list', table);
}

// ------------------------------------------------------------------------------------------
// Host Management
// ------------------------------------------------------------------------------------------

function getHosts() {
	callRPC('/host.list', getHostsCallback);
}

function getHostsCallback(hostlist) {
	setHostlist(hostlist);
	renderHosts();
}

/* AJAX call spawn to delete command */
function deleteMacro(label) {
	if (confirm("delete macro "+label+" ?")) {
		callRPC('/macro.delete?label='+encodeURIComponent(label)+"&owner="+getUser(), function(rpc) { rpcCallback(rpc); getMacros(); });
	}
	return false;
}

function renderHosts() {
	safeCall(renderHostsCall);
}

function renderHostsCall() {
	var table = {
		allscroll:true,
		id:"table_hosts", 
		label:["#","host","port","uuid","type","state","group","score","queued","running","total","disk","rebalance","drop","fail (fs dead)", "fail (fs okay)", "toggle host", "toggle minion"],
		rowadd:[,,,,'class="center"','class="center"','class="center"','class="center"', 'class="center"','class="center"','class="center"','class="center"','class="center"','class="center"','class="center"','class="center"','class="center"','class="center"'],
		rows:[],
		rowon:0,
		rowoff:17,
	};
	var stats = {
		disk:[0,0],
	};
	var sumqueued = 0;
	var sumrunning = 0;
	var sumavail = 0;
	// render host checkbox list
	groups = {};
	var hostlist = lastHostlist;
	for (var i=0; i<hostlist.length; i++) {
		var host = hostlist[i];
		sumqueued += host.queued.length;
		sumrunning += host.running.length;
		if (host.replicating) {
			sumrunning += host.replicating.length
		}
		if (host.backingup) {
			sumrunning += host.backingup.length
		}
		sumavail += host.availableTaskSlots;
		var shortName = host.host.replace(/\.[a-zA-Z\.]+:/, ':').split(':')[0];
		if (host.uuid) {
			hosts[host.uuid] = host;
		}
		// update group data
		if (hostlist.length > 12 || !host.group || host.group == 'none') {
			host.group = 'G'+(i%4);
		}
		var group = groups[host.group] || [];
		group.push([host.uuid,shortName,currentJob && currentJob.checked[host.uuid] ? 1 : 0]);
		groups[host.group] = group;
		var score = host.score ? host.score : 0;
		var running = host.running ? host.running.length : 0;
		if (host.replicating)
		{
			running += host.replicating.length;
		}
		if (host.backingup)
		{
			running += host.backingup.length;
		}
		var stopped = host.stopped;
		var resMax = host.max;
		var resUsed = host.used;
		table.rows.push([
            i,
			shortName,
			host.port,
			'<a href="#" onclick="Spawn.showHostTasks(\''+host.uuid+'\')">'+(isCompact ? host.uuid.split('-')[0] : host.uuid)+'</a>',
			host.minionTypes,
            host.spawnState,
			host.group || '-',
			parseFloat(score.toFixed(2)),
			host.queued.length,
			running,
            running + stopped,
			twocell(fnum(resUsed.disk,true), fnum(resMax.disk,true)),
			'<a href="#" onclick="Spawn.rebalanceHost(\''+host.uuid+'\')">R</a>',
			'<a href="#" onclick="Spawn.dropHost(\''+host.uuid+'\')">X</a>',
			generateFailHostLink(host, 1),
			generateFailHostLink(host, 0),
			generateToggleHostLink(host, false),
			generateToggleHostLink(host, true)
		]);
		stats.disk[0] += host.used.disk;
		stats.disk[1] += host.max.disk;
	}
	['disk'].forEach(function (key) {
		var used = stats[key][0];
		var total = stats[key][1];
		$('status_'+key+'_pct').innerHTML = fnum(Math.ceil((used*100)/total));
		$('status_'+key+'_title').title = fnum(total,true);
	});
	// render group checkbox list
	var html = '<table>';
	var groupArray = [];
	for (var group in groups) {
		groupArray.push(group);
	}
	groupArray.sort();
	for (var g=0; g<groupArray.length; g++) {
		var group = groupArray[g];
		var groupHosts = groups[group];
		html += '<tr><th><button onclick="Spawn.selectHostGroup(this,\''+group+'\'); return false;"</button>'+group+'</th>';
		for (var i=0; i<groupHosts.length; i++) {
			var hostInfo = groupHosts[i];
			html += '<td><input type=checkbox id="ck_'+hostInfo[0]+'" value="'+hostInfo[0]+'" '+(hostInfo[2] ? 'checked':'')+' onclick="Spawn.selectHost(this,\''+hostInfo[0]+'\')">';
			html += '<a title="'+hostInfo[1]+'">'+hostInfo[1].split('.')[0]+'</a></input></td>';
		}
		html += '</tr>';
	}
	queued=sumqueued;
	$('select_job_hosts').innerHTML = html+'</table>';
	$('status_hosts').innerHTML = hostlist.length;
	$('status_queued').innerHTML = queued+spawnqueuesize;
	$('status_queued_error').innerHTML = spawnqueueerrorsize;
	$('status_avail_slots').innerHTML = sumavail;
	//callRPC("/task.queue.size?id=1", spawnQueueSizeCallback);
	$('status_running').innerHTML = sumrunning;
	window.Spawn.hosts = hosts;
	renderTable('hosts_list', table);
	showHostTasks(db['showHost']);
}

function generateToggleHostLink(host, minionOnly) {
	if (!host) {
		return "";
	}
	var toChange;
	if (host.disabled) {
		toChange = host.uuid + "," + host.host;
	}
	else {
		toChange = minionOnly ? host.uuid : host.host;
	}
	return host.disabled ? '<a href="#" onclick="Spawn.enableHost(\''+toChange+'\')">Enable</a>' : '<a href="#" onclick="Spawn.disableHost(\''+toChange+'\')">Disable</a>'
}

function generateFailHostLink(host, deadFs) {
	if (host.spawnState && host.spawnState.indexOf("queued to fail") >= 0) {
		return '<a href="#" onclick="Spawn.cancelHostFail(\''+host.uuid+'\')">cancel failure</a>';
	}
	return '<a href="#" onclick="Spawn.hostFailInfo(\''+host.uuid+'\', '+deadFs+')">' + (deadFs ? '!' : '@') + '</a>'
}

function spawnQueueSizeCallback(rpc) {
	spawnqueuesize = parseInt(rpc['size']);
	spawnqueueerrorsize = parseInt(rpc['sizeErr']);
	$('status_queued').update(queued + spawnqueuesize);
	$('status_queued_error').update(spawnqueueerrorsize);
	//console.log("sp: "+spawnqueuesize+", s+sp: "+(queued + spawnqueuesize));
}

/* render list of host/nodes for a selected job */
function showHostTasks(uuid) {
	if (!uuid) {
		return;
	}
	$('host_tasks').innerHTML = "---";
	var host = hosts[uuid];
	db['showHost'] = uuid;
	var table = {
		allscroll:true,
		id:"table_host_tasks", 
		label:["job","description","node","qpos","pri","state","submit","stop","kill"],
		labeladd:[,,,,],
		rowadd:['nowrap','nowrap','class=center','class="center"','class="center"','class="center"','nowrap class="center"','class="center"','class="center"'],
		rows:[],
		rowon:0,
		rowoff:16,
        title:"Tasks for node '"+uuid+"'"
	};
	var running = host ? host.running : [];
	for (var i=0; i<running.length; i++) {
		var node = running[i];
		var job = jobs[node.id || node.jobUuid] || {id:'??',description:'??',priority:0,submitTime:0};
		table.rows.push([
			'<a href="#" onclick="Spawn.showJobDetail(\''+node.jobUuid+'\',true);Spawn.showTab(\'jobs\')">'+node.jobUuid+'</a>',
			job.description,
			node.nodeNumber,
			'',
			job.priority,
			"running",
			fdate(job.submitTime),
			'<a href="#" title="stop job" onclick="Spawn.stopJob(\''+job.id+'\',0); return false;">S</a>',
			'<a href="#" title="kill task" onclick="Spawn.stopJob(\''+job.id+'\',1,'+node.nodeNumber+'); return false;">K</a>',
		]);
	}
	var replicating = host ? host.replicating : [];
	var backingup = host ? host.backingup : []
	for (var i=0; i<replicating.length; i++) {
		var node = replicating[i];
		var job = jobs[node.id || node.jobUuid] || {id:'??',description:'??',priority:0,submitTime:0};
		table.rows.push([
			'<a href="#" onclick="Spawn.showJobDetail(\''+node.jobUuid+'\',true);Spawn.showTab(\'jobs\')">'+node.jobUuid+'</a>',
			job.description,
			node.nodeNumber,
			'',
			job.priority,
			"replicating",
			fdate(job.submitTime),
			'<a href="#" title="stop job" onclick="Spawn.stopJob(\''+job.id+'\',0); return false;">S</a>',
			'<a href="#" title="kill task" onclick="Spawn.stopJob(\''+job.id+'\',1,'+node.nodeNumber+'); return false;">K</a>',
		]);
	}
	for (var i=0; i<backingup.length; i++) {
		var node = backingup[i];
		var job = jobs[node.id || node.jobUuid] || {id:'??',description:'??',priority:0,submitTime:0};
		table.rows.push([
			'<a href="#" onclick="Spawn.showJobDetail(\''+node.jobUuid+'\',true);Spawn.showTab(\'jobs\')">'+node.jobUuid+'</a>',
			job.description,
			node.nodeNumber,
			'',
			job.priority,
			"backup",
			fdate(job.submitTime),
			'<a href="#" title="stop job" onclick="Spawn.stopJob(\''+job.id+'\',0); return false;">S</a>',
			'<a href="#" title="kill task" onclick="Spawn.stopJob(\''+job.id+'\',1,'+node.nodeNumber+'); return false;">K</a>',
		]);
	}
	var queued = host ? host.queued : [];
	for (var i=0; i<queued.length; i++) {
		var node = queued[i];
		var job = jobs[node.id || node.jobUuid] || {id:'??',description:'??',priority:0,submitTime:0};
		//console.log(['queued',node.id,node.jobUuid,job]);
		table.rows.push([
			'<a href="#" onclick="Spawn.showJobDetail(\''+node.jobUuid+'\',true);Spawn.showTab(\'jobs\')">'+node.jobUuid+'</a>',
			job ? job.description : '??',
			node.nodeNumber,
			i,
			job.priority,
			"queued",
			fdate(job.submitTime),
			'<a href="#" title="stop task" onclick="Spawn.stopJob(\''+job.id+'\',0); return false;">S</a>',
			'',
		]);
	}
	renderTable('host_tasks', table, false);
	showHide('host_tasks', true);
}

// ------------------------------------------------------------------------------------------
// Job Management
// ------------------------------------------------------------------------------------------

function getJobs() {
	callRPC('/job.list', getJobsCallback);
}

function getJobsCallback(jobslist) {
	setJoblist(jobslist);
	renderJobs();
}

function newJob() {
	fillFormsFromJob(null, false);
    $('job_edit_title').innerHTML = 'New Job';
	$('form_job_create').style.display = '';
	$('form_job_clone').style.display = 'none';
	$('form_job_save').style.display = 'none';
    $('form_job_download').style.display = 'none';
	$('form_job_minionType').enable();
	$('tr_job_tasks').style.display = '';
	showEdit('job_edit', true);
	refreshEditText(form_config_editor);
}

/* pass job data to new job tab and switch context */
function editJob(id) {
    $('job_edit_title').innerHTML = 'Edit Job';
	//console.log(['edit job', id, jobs]);
	try {
	if (!jobs[id]) {
		alert('invalid job id: '+id);
		return;
	}
	$('form_job_create').style.display = 'none';
	$('form_job_clone').style.display = 'none';
	$('form_job_save').style.display = '';
    $('form_job_download').style.display = '';
	$('tr_job_tasks').style.display = 'none';
	callRPC("/job.get?id="+id, editJobCallback);
	setPollerLive();
	} catch (e) { console.log(e); }
}

/* pass job data to new job tab and switch context */
function cloneJob(id) {
    $('job_edit_title').innerHTML = 'Clone Job';
	if (!jobs[id]) {
		alert('invalid job id: '+id);
		return;
	}
	$('form_job_create').style.display = 'none';
	$('form_job_clone').style.display = '';
	$('form_job_save').style.display = 'none';
    $('form_job_download').style.display = '';
	$('tr_job_tasks').style.display = '';
	callRPC("/job.get?id="+id, cloneJobCallback);
	setPollerLive();
}

function editJobCallback(job) {
	try {
		jobs[job.id] = job;
		fillFormsFromJob(job.id, false);
		showEdit('job_edit', true);
		refreshEditText(form_config_editor);
	} catch (e) {
		console.log(e);
	}
}

function cloneJobCallback(job) {
	try {
		jobs[job.id] = job;
		fillFormsFromJob(job.id, true);
		showEdit('job_edit', true);
		refreshEditText(form_config_editor);
	} catch (e) {
		console.log(e);
	}
}

function checkJobDirs(id) {
	var job = jobs[id];
	if (!job) {
		alert('no such job '+id);
		return;
	}
	window.open('/jobdirs.check?id='+id);
	return false;
}

function fixJobDirs(id) {
	var job = jobs[id];
	if (!job) {
		alert('no such job '+id);
		return;
	}
	if (confirm("fix job '"+job.description+"'  ["+id+"] ?")) {
		callRPC('/jobdirs.fix?id='+id, function(data) { alert(data); });
	}
	return false;
}

/* AJAX call spawn to cancel and delete job */
function deleteJob(id) {
	var job = jobs[id];
	if (!job) {
		alert('no such job '+id);
		return;
	}
	if (getUser() != job.owner && !confirm('are you the owner of this job?')) {
		return;
	}
	if (confirm("delete job '"+job.description+"'  ["+id+"] ?")) {
		callRPC('/job.delete?id='+id, function(rpc) { rpcCallback(rpc); });
	}
	return false;
}

/* AJAX call spawn to rebalance job */
function rebalanceJob(id) {
	var job = jobs[id];
	var totalSize = 0;
	for (i=0; i<job.nodes.length; i++) {
		totalSize += job.nodes[i].fileBytes;
	}
	var averageTaskSize = totalSize / job.nodes.length;
	var tasksToMove = prompt("Enter number of tasks to move, or leave blank to use default value. Average task size for this job is " + fnum(averageTaskSize,true) + " bytes.","");
	if (!(tasksToMove === null))
	{
		window.open('/job.rebalance?id='+id+'&tasksToMove='+tasksToMove);
	}
	return false;
}

/* AJAX call spawn to synchronize job */
function synchronizeJob(id) {
	if (confirm("synchronize job "+id+"?")) {
		callRPC('/job.synchronize?id='+id, function(rpc) { rpcCallback(rpc); });
	}
	return false;
}

/* AJAX call spawn to rekick job */
function rekickJob(id,node) {
	try {
		textappend=setup.quiesce?"(when the cluster is quiesced!) ":"";
		if (confirm("rekick job "+id+" "+(node >= 0 ? "node "+node : "")+textappend+"?")) {
			callRPC('/job.submit?manual=1&spawn=1&id='+id+(node >= 0 ? '&select='+node : ''), function(rpc) { rpcCallback(rpc); });
		}
	} catch (e) { console.log(['kick error', e]); }
	return false;
}

/* AJAX call spawn to cancel and delete job */
function stopJob(id,force,node) {
	if (confirm((force?"kill":"stop")+" job "+id+" ?")) {
		var cancel = "1";
		var kill = force ? "1" : "0";
		if (jobs[id] && jobs[id].rekickTimeout) {
			cancel = confirm("keep rekick @"+jobs[id].rekickTimeout+" ?") ? "0" : "1";
		}
		callRPC('/job.stop?id='+id+'&cancel='+cancel+'&force='+kill+(node >= 0?'&node='+node:''), function(rpc) { rpcCallback(rpc); });
	}
	return false;
}

/* AJAX call spawn to rollback job data */
function revertJob(id,node) {
	if (confirm("revert job "+id+" ?")) {
		callRPC('/job.revert?id='+id+(node >= 0?'&node='+node:''), function(rpc) { rpcCallback(rpc); });
	}
	return false;
}

/* set respawn field to false and validate */
function submitJob(create,spawn) {
	currentJob.create = create;
	currentJob.spawn = spawn;
	if (validateJob()) {
		showEdit('job_edit',false);
		return true;
	}
	return false;
}

/* fill job submit form using job object */
function fillFormsFromJob(uuid, clone) {
	var job = uuid ? jobs[uuid] : {nodes:[]};
 	currentJob = job;
	currentJob.checked = {};
	currentJob.create = false;
	currentJob.spawn = false;
	form_config_editor.setValue(job.config || '');
	$('form_job_owner').value = getUser() || job.owner;
	$('form_job_desc').value = job.description || 'describe this job';
	$('form_job_nodes').value = job.nodes.length == 0 ? 1 : job.nodes.length;
	$('form_job_ondone').value = job.onComplete || '';
	$('form_job_onerror').value = job.onError || '';
	$('form_job_rekick').value = typeof job.rekickTimeout == 'undefined' ? '' : job.rekickTimeout;
	$('form_job_logkill').value = job.killSignal || '';
	$('form_job_hourlyBackups').value = typeof job.hourlyBackups == 'undefined' ? '0' : job.hourlyBackups;
	$('form_job_dailyBackups').value = typeof job.dailyBackups == 'undefined' ? '3' : job.dailyBackups;
	$('form_job_weeklyBackups').value = typeof job.weeklyBackups == 'undefined' ? '0' : job.weeklyBackups;
	$('form_job_monthlyBackups').value = typeof job.monthlyBackups == 'undefined' ? '0' : job.monthlyBackups;
	$('form_job_replicas').value = typeof job.replicas == 'undefined' ? '1' : job.replicas;
	$('form_job_readOnlyReplicas').value = typeof job.readOnlyReplicas == 'undefined' ? '0' : job.readOnlyReplicas;
	$('form_job_dontAutoBalanceMe').value = typeof job.dontAutoBalanceMe == 'undefined' ? '0' : job.dontAutoBalanceMe ? '1' : '0';
	$('form_job_maxSimulRunning').value = typeof job.maxSimulRunning == 'undefined' ? '0' : job.maxSimulRunning;
	$('form_job_minionType').value = typeof job.minionType == 'undefined' ? 'default' : job.minionType;
	if (clone) {
		$('form_job_minionType').enable();
	}
	else
	{
		$('form_job_minionType').disable();
	}
	$('form_job_maxrun').value = typeof job.maxRunTime =='undefined' ? '60' : job.maxRunTime;
	$('form_job_priority').value = job.priority || '';
	$('select_job_command').selectedIndex = job.command ? commandList.indexOf(job.command) : 0;
	// query control settings
	if (job.queryConfig) {
		$('form_job_qc_canQuery').checked = job.queryConfig.canQuery;
		$('form_job_qc_queryTraceLevel').checked = parseInt(job.queryConfig.queryTraceLevel || 0) > 0;
		$('form_job_qc_consecutiveFailureThreshold').value = job.queryConfig.consecutiveFailureThreshold || '';
	}
	// reset check boxes
	for (uuid in hosts) {
		var ckbox = $('ck_'+uuid);
		if (ckbox) ckbox.checked = false;
	}
	// set checks and update list
	var jobHosts = {};
	var missingHosts = [];
	for (var i=0; i<job.nodes.length; i++) {
		var hostuuid = job.nodes[i].hostUuid;
		var ckbox = $('ck_'+hostuuid);
		jobHosts[hostuuid] = true;
		if (ckbox && !clone) {
			ckbox.checked = true;
			currentJob.checked[hostuuid] = true;
		} else if (!clone && missingHosts.indexOf(hostuuid) < 0) {
			missingHosts.push(hostuuid);
		}
	}
	if (job.parameters) {
		if (paramWrap) {
			var count = job.parameters.length;
			var colCount = 1;
			if (count > 3) {
				colCount = 3;
			}
			rowCount = Math.ceil(count / colCount);
			var rows = [];
			for (var r=0; r<rowCount; r++) {
				var row = ['<tr>'];
				for (var c=0; c<colCount; c++) {
					var param = job.parameters[r + rowCount * c];
					if (param) {
						row.push(['<th>',param.name,'</th>'].join(''));
						row.push(['<th>','<input name="sp_'+param.name+'" value="'+(param.value || '')+'" size=20>','</th>'].join(''));
					} else {
						row.push(['<td>','</td>','<td>','</td>'].join(''));
					}
				}
				row.push('</tr>');
				rows.push(row.join(''));
			}
			$('form_job_params').innerHTML = '<table>'+rows.join(' ')+'</table>'
		} else {
			var rows = [];
			for (var i=0; i<job.parameters.length; i++) {
				var param = job.parameters[i];
				rows.push('<tr><th>'+param.name+'</th><td><input name="sp_'+param.name+'" value="'+(param.value || '')+'" size=20></td></tr>');
			}
			$('form_job_params').innerHTML = '<table>'+rows.join(' ')+'</table>'
		}
	} else {
		$('form_job_params').innerHTML = '';
	}
	if (missingHosts.length > 0) {
		alert('missing required hosts '+missingHosts);
	}
}

function renderJobs() {
	safeCall(renderJobsCall);
}

function renderJobsCall() {
	var cmdcount = {};
	var filter = new ColumnFilter(["description","owner","creator","id"]);
	var table = {
		allscroll:true,
		id:"table_jobs",
		filterFunction: renderJobs,
		labeladd:['','nowrap',"width=100%",''],
		label: [
			"query","job id","description",
			"tasks","status","detail",
            "submit","start","end",
            "rekick","runs","files","bytes"],
		rowadd: [
			'class=center',"nowrap","nowrap",
            "class=num",'nowrap class="center"','nowrap class="center"',
            'class="center" nowrap','class="center" nowrap','class="center" nowrap','class="center"',
            '','class="num center"','class="num center"'],
		rows:[],
		rowon:0,
		rowoff:16
	};
	var filterList = {};
	var tasks = 0;
	var joblist = lastJoblist;
	var jobFilter = db['jobsfilter'] || '';
	filter.setFilterValue(jobFilter);
	for (var i=0; i<joblist.length; i++) {
		var job = joblist[i],
			files = job.files,
			bytes = job.bytes,
			sid = job.id.split('-'),
			pithy = isCompact ? sid[0] : sid[0]+'-...';
		job.showing = false;
		tasks += job.nodes;
		if (!cmdcount[job.command]) {
			cmdcount[job.command] = [];
		}
		cmdcount[job.command].push(job.id);
		// collect [] auto-filter tags
		var fmatch = job.description ? job.description.match(/\[\w+\]/g) : null;
		if (fmatch) {
			for (var j=0; j<fmatch.length; j++) {
				filterList[fmatch[j].substring(1,fmatch[j].length-1)] = 1;
			}
		}
		if (jobFilter.length > 0)
		{
			if(!filter.match(job) && ["ERR","RUN","DONE"].indexOf(jobFilter) < 0 ){
				continue;
			}
			if (job.state!=5 && jobFilter == "ERR") {
				continue;
			}
			if (job.countActiveTasks <= 0 && jobFilter == "RUN") {
				continue;
			}
			if (!job.endTime && jobFilter == "DONE") {
				continue;
			}
		}
		job.showing = true;
		var enableJob = ' (<a href="#" title="enable job" onclick="Spawn.setJobRunnable(\''+job.id+'\',true)">off</a>)';
	    var state = ["idle","scheduled","running","degraded","unknown","ERROR", "REBALANCE"][job.state]
        var detail = [];
	    if (job.state == 0 && job.wasStopped) {
            detail.push('stopped');
	    }
		if (job.running == job.done && job.running < job.nodes) {
            detail.push('blocked');
		}
        if (job.disabled) {
            detail.push('disabled');
        }
		table.rows.push([
			setup.queryHost && job.queryConfig && job.queryConfig.canQuery ? '<a href="http://{{boothost}}/me/query/query.html?cluster={{cluster}}&job='+job.id+'" title="query job" target="_morgoth">Q</a>' : '',
			'<a href="#" title="inspect" onclick="Spawn.showJobDetail(\''+job.id+'\',true,true); return false;">'+pithy+'</a>',
			'<a href="#" title="edit" onclick="Spawn.editJob(\''+job.id+'\'); return false;">'+job.description+'</a>',
            job.done + "/" + job.nodes,
            state,
            detail.length > 0 ? detail.join(',') : '-',
			job.submitTime ? [fdate(job.submitTime),job.submitTime] : ['-',0],
			job.startTime ? [fdate(job.startTime),job.startTime] : ['-',0],
			job.endTime ? [fdate(job.endTime),job.endTime] : ['-',0],
			job.rekickTimeout || '-',
			job.runCount || '-',
			[fnum(files,true),files],
			[fnum(bytes,true),bytes],
		]);
	}
	// render selection drop-down
	var flist = [];
	for (var f in filterList) {
		flist.push(f);
	}
	flist.sort();
	var html = '<select onchange="Spawn.setJobFilter(this.options[this.selectedIndex].value)"><option value=""></option>';
	for (var j=0; j<flist.length; j++) {
		html += '<option value="['+flist[j]+']">'+flist[j]+'</option>';
	}
	$('filter_list').innerHTML = html + '</select>';
	$('status_jobs').innerHTML = joblist.length;
	$('status_tasks').innerHTML = tasks;
	showJobDetail(db['spawn.job_show']);
	window.Spawn.jobs = jobs;
	renderTable('jobs_list',table);
}

function downloadJob() {
    window.open('http://'+setup.spawnHost+'/job.expand?id='+currentJob.id+'&auth='+rpcAuth);
    return false;
}

function showJobDetail(uuid,force,focus) {
    var same = (uuid == db['spawn.job_show']);
	db['spawn.job_show'] = uuid;
	if (!force && lastJob && lastJob.id == uuid) {
		showJobDetailCallback(lastJob);
	} else {
		callRPC("/job.get?id="+uuid, function(job) { safeCall(showJobDetailCallback,job,focus); });
	}
    if (!same) showHide('job_log', false);
	setPollerLive();
}

/* render list of host/nodes for a selected job */
function showJobDetailCallback(job,focus) {
	if (job) {
        $('sel_job').style.display = 'inline-block';
        $('sel_job_id').value = job.id;
        $('sel_job_id').focus();
        $('sel_job_id').select();
		jobs[job.id] = job;
		lastJob = job;
	} else if (lastJob) {
		job = lastJob;
	}
	if (!(job && job.id)) {
        showHide('job_detail', false);
		return;
	}
	var uuid = job.id;
	$('sel_job_edit').onclick = function() { editJob(uuid); };
    $('sel_job_kick').onclick = function() { rekickJob(uuid); };
    $('sel_job_stop').onclick = function() { stopJob(uuid,0); };
    $('sel_job_kill').onclick = function() { stopJob(uuid,1); };
	$('sel_job_clone').onclick = function() { cloneJob(uuid); };
	$('sel_job_balance').onclick = function() { rebalanceJob(uuid); };
    $('sel_job_fsck').onclick = function() { checkJobDirs(uuid); };
   	$('sel_job_fsfix').onclick = function() { fixJobDirs(uuid); };
    $('sel_job_able').onclick = function() { setJobRunnable(uuid,job.disabled); };
    $('sel_job_able').innerHTML = job.disabled ? 'enable' : 'disable';
    $('sel_job_delete').onclick = function() { deleteJob(uuid); };
	var nodes = job.nodes;
	var table = {
		allscroll:true,
		id:"table_job_nodes", 
		label:["kick","node","done","state","detail","host","bytes","revert","stop","kill"],
		labeladd:[,,,],
		rowadd:['class=center','class=center','class=center','nowrap class=center','nowrap class=center','class=center','class=center','nowrap class=center','class="center"','class="center"'],
		rows:[],
		rowon:0,
		rowoff:16,
        title:"Job Tasks"
	};
	var diffport = false;
	var lastport = 0;
	for (var i=0; i<nodes.length; i++) {
		var host = hosts[nodes[i].hostUuid];
		if (!host) {
			continue;
		}
		diffport |= (lastport != 0 && host.port != lastport);
		lastport = host.port;
	}
	for (var i=0; i<nodes.length; i++) {
		var node = nodes[i];
		var host = hosts[node.hostUuid];
		var alt = "starts:"+node.starts+" errors:"+node.errors+" files:"+fnum(node.fileCount)+" bytes:"+fnum(node.fileBytes);
		var nodestate = ["idle","busy","error","allocated","backup","replicate", "UNKNOWN", "rebalance","revert","disk_full","swapping","queued","migrating"][node.state];
        var detail = [];
		if (node.state == 0 && node.wasStopped) {
            detail.push('stopped');
		}
		if (node.state == 2 && node.errorCode) {
            detail.push(descriptionForErrorCode(node.errorCode))
		}
		table.rows.push([
			node.state == 0 || node.state == 2 ? '<a href="#" title="rekick job" onclick="Spawn.rekickJob(\''+job.id+'\','+node.node+'); return false;">K</a>' : 'K',
			node.node,
		        node.runCount > 0 && node.runCount == job.runCount && (node.state == 0 || node.state == 2) ? 'Y' : '-',
			nodestate,
            detail.length > 0 ? detail.join(',') : '-',
			host ? '<a href="#" title="'+alt+'" onclick="Spawn.showJobLogs(\''+host.host+hostDomain+'\','+host.port+',\''+uuid+'\','+node.node+')">'+host.host+(diffport?':'+host.port:'')+'</a>' : node.hostUuid,
			fnum(node.fileBytes,true),
			'<a href="#" title="revert node" onclick="Spawn.revertJob(\''+job.id+'\','+node.node+'); return false;">R</a>',
			'<a href="#" title="stop node" onclick="Spawn.stopJob(\''+job.id+'\',0,'+node.node+'); return false;">S</a>',
			'<a href="#" title="force kill node" onclick="Spawn.stopJob(\''+job.id+'\',1,'+node.node+'); return false;">K</a>',
		]);
	}

    for (var i=0; i<lastJoblist.length; i++) {
        if (lastJoblist[i].id == job.id) {
            var info = lastJoblist[i];
            $('job-info-id').value = info.id;
            $('job-info-about').value = info.description;
            $('job-info-creator').value = info.creator;
            $('job-info-owner').value = info.owner;
            $('job-info-ttotal').value = info.nodes;
            $('job-info-trun').value = info.running - info.done;
            $('job-info-tdone').value = info.done;
            $('job-info-terror').value = info.errored;
            $('job-info-tbackup').value = info.backups;
            $('job-info-treplica').value = info.replicas;
            $('job-info-troreplica').value = info.readOnlyReplicas;
            $('job-info-tfiles').value = fnum(info.files,true);
            $('job-info-tsize').value = fnum(info.bytes,true);
            $('job-info-rtotal').value = info.runCount || 0;
            $('job-info-rpriority').value = info.priority;
            $('job-info-rsubmit').value = fsdate(info.submitTime);
            $('job-info-rstart').value = fsdate(info.startTime);
            $('job-info-rend').value = fsdate(info.endTime);
            $('job-info-rkick').value = info.rekickTimeout || '';
            $('job-info-rlimit').value = info.maxRunTime || '';
            $('job-info-rspan').value = (info.endTime > info.startTime ? Math.round((info.endTime - info.startTime)/1000) : '');
            break;
        }
    }

	renderTable('job_nodes', table, false);
	showHide('job_detail', true);
}

function descriptionForErrorCode(code) {
	if (code > 0) {
		return "job error: " + code;
	}
	else {
		switch(code) {
		case -100:
			return "backup failed";
		case -101:
			return "replicate failed";
		case -102:
			return "revert failed";
		case -103:
			return "swap failed";
		case -104:
			return "failed host";
		case -105:
			return "kick failed";
		case -106:
			return "dir error";
		case -107:
			return "script exec error";
		default:
			return "unknown";
		}
	}
}

function updateJobLog(ev) {
	var e = document.event || window.event || ev;
	if (e && e.keyCode == 13) {
		showJobLogs();
	}
}

function renderJobProfile(obj) {
	var state = { callMax: 0, timeMax: 0, lines: [] };
	for (var k in obj.paths) {
		walkPath(obj.paths[k], 0, state);
	}
	for (var k in obj.paths) {
		state.lines.push([0, k]);
		walkPath(obj.paths[k], 0, state, true);
	}
	var html = '<table class="profile">';
	html += '<thead><tr><th>type</th><th>detail</th><th>calls</th><th>time</th></tr></thead>';
	html += '<tbody>';
	for (var i=0; i<state.lines.length; i++) {
		var line = state.lines[i];
		if (line[0] == 0) {
			html += '<tr><th colspan=4>'+line[1]+'</th></tr>';
		} else {
			show = line[4] >= 50 ? 'hot' : line[4] >= 15 ? 'warm' : '';
			html += '<tr class="'+show+'"><td><div style="width:'+(line[0]*10)+'px;display:inline-block"></div>';
			if (line[1] == '') {
				html += '&raquo;</td><td colspan=3></td></tr>';
			} else {
				html += line[1]+'</td>';
				html += '<td>'+line[2]+'</td><td class="right">'+line[3]+'</td><td class="right">'+line[4]+'</td></tr>';
			}
		}
	}
	html += '</tbody>';
	html += '</table>'
	showEdit('job_profile', true);
	$('job_profile_table').innerHTML = html;
}

function dec2(pct) {
	return (pct*100).toFixed(2);
}

function walkPath(path, depth, state, updatePath) {
	var profiled = path.profileCalls >= 0;
	if (typeof(path.type) == 'string' && profiled) {
		if (updatePath) {
			path.profile = {
				call: dec2(path.profileCalls / state.callMax),
				time: dec2(path.profileTime / state.timeMax),
			};
			state.lines.push([ depth, path.type, path.keys || path.key || path.value || path.debugKey || path.call || path.path || path.format || '' , path.profile.call, path.profile.time ]);
		} else {
			state.callMax = Math.max(state.callMax, path.profileCalls);
			state.timeMax = Math.max(state.timeMax, path.profileTime);
		}
	}
	if (path.length > 0) {
		if (updatePath && depth > 0) {
			state.lines.push([depth, '', '', 0, 0, path]);
		}
		for (var i=0; i<path.length; i++) {
			walkPath(path[i], depth+1, state, updatePath);
		}
	}
	if (typeof(path.list) == 'object' && profiled) {
		walkPath(path.list, depth+1, state, updatePath);
	}
	if (typeof(path.each) == 'object' && profiled) {
		walkPath(path.each, depth+1, state, updatePath);
	}
}

function dumpJobProfile() {
	if (!lastLog) {
		return;
	}
	var task = getTask(lastLog.job, lastLog.node);
	if (task) {
		if (task.state == 1) {
			var host = lastLog.host;
			var port = task.port;
			jsonp("http://"+host+":"+port+"/profile?dump=1&jsonp=Spawn.renderJobProfile");
		} else {
			var host = lastLog.host;
			var port = lastLog.port;
			jsonp("http://"+host+":"+port+"/job.profile?id="+lastLog.job+"&node="+lastLog.node);
		}
	}
}

/* enable/disable/dump profiling data */
function setJobProfiling() {
	if (!lastLog) {
		return;
	}
	var task = getTask(lastLog.job, lastLog.node);
	var host = lastLog.host;
	var port = task.port;
	var url = 'about:blank';
	if ($('job_profile_on').checked) {
		url = "http://"+host+":"+port+"/profile?enable=1";
	} else {
		url = "http://"+host+":"+port+"/profile?enable=0";
	}
	showHide('job_log', true);
}

/* set url for job log iframe */
function showJobLogs(host, port, job, node) {
	lastLog = host ? {host:host, port:port, job:job, node:node} : lastLog;
	if (lastLog.host) {
		var lines = $('job_log_lines').value || db['spawn.log_lines'];
		var offset = $('job_log_head').checked ? '0' : '-1';
		var url = 'about:blank';
        var stdout = $('job_log_stdout').checked;
        var rpc = "/job.log?id="+lastLog.job+"&node="+lastLog.node+"&offset="+offset+"&lines="+lines+"&out="+(stdout?"1":"0");
        var rpcopt = { host:"http://"+lastLog.host+":"+lastLog.port };
        $('job_log_detail').innerHTML = '';
        callRPC(rpc+"&out=1", function(logs) {
            showHide('job_log', true);
            var div = $('job_log_detail');
            div.innerHTML = logs.out;
            div.scrollTop = div.scrollHeight;
        }, rpcopt);
		db['spawn.log_lines'] = lines;
	}
}

function setJobFilter(val,ev) {
	var e = document.event || window.event || ev;
	if (val || (e && e.keyCode == 13)) {
		filter = val || $('form_filter').value;
		$('form_filter').value = filter;
		db[db[tabSetting]+'filter'] = filter;
		var table = $('table_'+db[tabSetting]);
		if(table && filterFunctions[table.id])
			filterFunctions[table.id].call();
		else
			console.log(table.id+" has no filter function");
	}
}

function clearJobFilter() {
	filter = '';
	$('form_filter').value = filter;
	db[db[tabSetting]+'filter'] = filter;
	var table = $('table_'+db[tabSetting]);
    if(table && filterFunctions[table.id])
        filterFunctions[table.id].call();
    else
        console.log(table.id+" has no filter function");
}

/* try to make sure no errors in JSON config */
function validateJob() {
	try {
		// update hidden job id if respawning
		if (!currentJob.create && currentJob.id) {
			$('send_id').value = currentJob.id;
		} else {
			$('send_id').value = '';
		}
		$('form_job_conf').value = form_config_editor.getValue();
		$('send_spawn').value = currentJob.spawn ? '1' : '';
		$('send_queryOK').value = $('form_job_qc_canQuery').checked ? 'true' : 'false';
		$('send_queryTrace').value = $('form_job_qc_queryTraceLevel').checked ? '1' : '0';
		// update hidden form fields from check data
		var checked = [];
		for (cn in currentJob.checked) {
			if (currentJob.checked[cn]) {
				checked.push(cn);
			}
		}
		//console.log([currentJob]);
		if (currentJob.disabled && confirm('job is disabled.  enable it?')) {
			$('send_enable').value = 1;
		}
		$('send_hosts').value = checked.join(',');
		setTimeout(init,500);
		return true;
	} catch (e) {
		console.log(['job validation error', e]);
		return false;
	}
}

/* enable/disable a single job */
function setJobRunnable(job,enable) {
	//console.log(['set job runnable',job,enable]);
	callRPC('/jobs.enable?jobs='+job+'&enable='+(enable?'1':'0'), rpcCallback);
}

/* set selected job list to runnable or not */
function setJobsRunnable(enable) {
	var sel = [];
	for (var i=0; i<lastJoblist.length; i++) {
		if (lastJoblist[i].showing) {
			sel.push(lastJoblist[i].id);
		}
	}
	var list = sel.join(",");
	callRPC('/jobs.enable?jobs='+list+'&enable='+(enable?'1':'0'), rpcCallback);
}

// ------------------------------------------------------------------------------------------
// Complete Setup
// ------------------------------------------------------------------------------------------

/* capture command keys */
window.addEventListener('keydown', windowKeyDown, false);
window.addEventListener('keypress', windowKeyPress, false);

/* capture and buffer on mouse move */
if (window.addEventListener) {
	window.addEventListener('mousemove', setPollerQueue, false);
	window.addEventListener('mousemove', touchMove, false);
}
if (window.addEventListener) {
	window.addEventListener('keydown', setPollerQueue, false);
}
if (window.addEventListener) {
	window.addEventListener('keyup', setPollerQueue, false);
}

/* hook up mouse wheel */
if (window.addEventListener) {
	window.addEventListener('DOMMouseScroll', wheelHandle, false);
	window.addEventListener('touchmove', touchMove, false);
	window.addEventListener('touchstart', touchStart, false);
}
window.onmousewheel = document.onmousewheel = wheelHandle;

/* from 'backspace means backspace' - a chrome behavior fixer upper */
window.addEventListener('keydown', function (e) {
	// If the key pressed was a backspace key, handle it specially
	if (e.keyIdentifier == 'U+0008' || e.keyIdentifier == 'Backspace')
	{
		// If the target of the backspace was the body element, handle it specially
		if (e.target == document.body)
		{
			// Prevent the default Backspace action from happening
			e.preventDefault ();
		}
	}
}, true);

/* export Spawn function object */
window.Spawn = {
	init : init,
	refresh : refresh,
	parse : parse,

    setHost : setHost,
    setAuth : setAuth,
	setUser : setUser,
    showTab : showTab,
    showEdit : showEdit,
	sortTable : sortTable,
    toggleQuiesce : toggleQuiesce,

	newCommand : newCommand,
	editCommand : editCommand,
	storeCommand : storeCommand,
	deleteCommand : deleteCommand,
	showCommandJobs : showCommandJobs,

	newAlias : newAlias,
	editAlias : editAlias,
	storeAlias : storeAlias,
	deleteAlias : deleteAlias,

	newMacro : newMacro,
	editMacro : editMacro,
	storeMacro : storeMacro,
	deleteMacro : deleteMacro,

	newJob : newJob,
	editJob : editJob,
	stopJob : stopJob,
	revertJob : revertJob,
	rekickJob : rekickJob,
	checkJobDirs : checkJobDirs,
    downloadJob : downloadJob,
	fixJobDirs : fixJobDirs,
	deleteJob : deleteJob,
	submitJob : submitJob,
	showJobDetail : showJobDetail,
	showJobLogs : showJobLogs,
	updateJobLog : updateJobLog,
	setJobRunnable : setJobRunnable,
	setJobsRunnable : setJobsRunnable,
	clearJobFilter : clearJobFilter,
	setJobFilter : setJobFilter,

	dropHost : dropHost,
	rebalanceHost : rebalanceHost,
	hostFailInfo: hostFailInfo,
	cancelHostFail: cancelHostFail,
	failHost : failHost,
	enableHost : enableHost,
	disableHost : disableHost,
	selectHost : selectHost,
	selectHostGroup : selectHostGroup,
	showHostTasks : showHostTasks,

	renderJobProfile : renderJobProfile,
	setJobProfiling : setJobProfiling,
	dumpJobProfile : dumpJobProfile,

	captureKey : captureKey,

	zkTruncate : zkTruncate,
	zkPush : zkPush,

	meshTruncate : meshTruncate,
	meshPush : meshPush,

	flowGraph: flowGraph,
};

})();
