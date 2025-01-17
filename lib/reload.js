"use strict";

var path = require('path')
var fs = require('fs')
var WebSocket = require('ws')
var RELOAD_FILE = path.join(__dirname, './reload-client.js')
var reloadCode = fs.readFileSync(RELOAD_FILE, 'utf8')

var ackReloadLog = require('./log.function')
var http = require('http')
var nodeStatic = require('node-static')
var promisePrompt = require('./promisePrompt.function')
var open = require('open')
var watch = require('watch')
var filterMaker = require('./filterMaker.function')

module.exports = servePath
module.exports.reloadSocketByHttp = reloadSocketByHttp
module.exports.middleware = middleware

module.exports.isRequestForReload = isRequestForReload
//module.exports.isHtmlRequest = isHtmlRequest
//module.exports.isReloadJsRequest = isReloadJsRequest

/** Returns promise of Object{httpServer:Object, reload:Function, port:Number}
  @pathTo String = currentWorkingDirectory
  @options{
    port Number,
    log Function = console.log,
    open Boolean = true,
    message String - when port is in use, tailor prompt messages label
    filter Function - file watching filter,
    onReload Function - called with every reload
    watch Boolean = true - Enable/disable watching files. Manual reload will be required
  }
*/
function servePath(pathTo, options){
  pathTo = pathTo || process.cwd()//currentWorkingDirectory
  return createFolderWatchServer(pathTo, options)
}

/** returns Function(request, response) . Does not watch files, use reloadSocketByHttp to establish watch and websocket
  @pathTo String - path to serve
  @httpServer Object - Use to establish file watching and reload websocket
  @options Object - See servePath options
*/
function middleware(pathTo, httpServer, options){
  options = options || {}
  var fileRouter = new nodeStatic.Server(pathTo,{cache:false});

  var routes = function(req, res){
    if( isReloadJsRequest(req) ){
      return routes.sendScript(req, res, options)
    }

    if( isHtmlRequest(req, options.html5Mode) ){
      return routes.indexRequest(req,res)
    }

    fileRouter.serve(req,res)
  }

  routes.sendScript = function(req,res,options){
    res.setHeader('Content-Type','text/javascript')

    reloadCode = reloadCode.replace('socketUrl.replace()', 'socketUrl.replace(/(^http(s?):\\/\\/)(.*:)(.*)/,' + (options.port ? '\'ws$2://$3' + options.port : '\'ws$2://$3$4') + '\')')

    res.end(reloadCode)
  },

  routes.indexRequest = function(req,res){
    // 7-2023 removed: was not targeting a /staging/clock/template.html when running `ack-reload --dir ./staging`
    //var reqFile = req.url.replace(/(.*\/)([^?]*)(\?.*)*/g,'$2')
    //reqFile = reqFile || 'index.html'
    //reqFile = reqFile.replace('/',path.sep)
    // var readFile = path.join(pathTo,reqFile)
    
    let reqFile = req.url.split('/').filter(v => v)
    if ( !reqFile.length ) {
      reqFile = ['index.html']
    }
    const readFile = path.join(pathTo, ...reqFile)

    respondHtmlFile(readFile, req, res)
    .catch(function(err){
      if(err.code=='ENOENT' && options.html5Mode){
        return respondHtmlFile(path.join(pathTo,'index.html'), req, res)
      }else{
        reqres404(req, res)
      }
    })
    .catch(function(e){
      ackReloadLog.error(e)
      reqres404(req, res)
    })
  }

  if(httpServer){
    routes.reload = reloadSocketByHttp(pathTo, httpServer, options)
  }

  return routes
}

function respondHtmlFile(readFile, req, res){
  return new Promise(function(res,rej){
    fs.readFile(readFile,function(err,buff){
      if(err)return rej(err)
      res(buff)
    })
  })
  .then(function(buff){
    res.setHeader('Content-Type','text/html')
    res.setHeader('Cache-Control','no-cache, no-store, must-revalidate')
    res.setHeader('Pragma','no-cache')
    res.setHeader('Expires','0')

    var fileContents = injectScriptTag(buff.toString())

    res.end(fileContents)
  })
}

function injectScriptTag(rawString){
  var cutHints = rawString.match(/<!--(?!<!)[^\[>](.|\n|\r)*?-->/g)
  rawString = rawString.replace(/<!--(?!<!)[^\[>](.|\n|\r)*?-->/g,'<!--reload-replaced-hint-->')

  var insertIndex = rawString.search(/\/body>/)
  const insertPlus = 6
  const insertAt = insertIndex + insertPlus

  //sync script tag load
  //var tag = '<script src="reload/reload.js"></script>'
  //async script tag load
  var tag = '<script>var s=document.createElement("script");s.src="reload/reload.js";document.body.appendChild(s)</script>'

  // console.log('insertIndex', insertIndex, rawString)

  if(insertIndex > 0){
    rawString = rawString.substring(0, insertAt) + tag + rawString.substring(insertAt, rawString.length)
  }else{
    rawString = rawString + tag
  }

  //repair rawString hints that were stripped out
  while(cutHints && cutHints.length){
    rawString = rawString.replace('<!--reload-replaced-hint-->', cutHints[0])
    cutHints.shift()
  }

  return rawString
}

function reqres404(req, res){
  var reqFile = req.url.replace(/(.*\/)([^?]*)(\?.*)*/g,'$2')
  reqFile = reqFile || 'index.html'
  reqFile = reqFile.replace('/',path.sep)

  res.setHeader('Content-Type','text/plain')
  res.statusCode = 404
  res.status = 404

  return res.end('404 '+reqFile+' File Not Found')
}

/** return promise */
function createFolderWatchServer(outputFileFolder, options){
  options = options || {}
  options.port = options.port || 8080
  options.log = options.log || ackReloadLog
  options.open = options.open==null ? true : options.open

  var app = module.exports.middleware(outputFileFolder, null, options)

  return startServer(app, options.port, options)
  .then(function(config){
    if(config.httpServer){
      config.reload = reloadSocketByHttp(outputFileFolder, config.httpServer, options)

      config.httpServer.on("close",function(){
        if( config.reload.monitor ){
          config.reload.monitor.stop()
        }
      })

      if(options.watch || options.watch==null){
        options.log('watching', outputFileFolder)
      }

      if(options.open){
        options.hostname = options.hostname || 'localhost'
        var urlPath = 'http://'+options.hostname+':' + config.port + '/'
        if(options.startPage){
          urlPath += options.startPage
        }
        open(urlPath)
        options.log('serving '+urlPath)
      }
    }else{
      options.log('live reload server and file watching skipped')
    }

    return config
  })
}

function reloadSocketByHttp(pathTo, httpServer, options){
  options = options || {}

  var WebSocketServer = WebSocket.Server
  var wss = new WebSocketServer({ server: httpServer })

  var reloader = function(){
    if(options.onReload)options.onReload()

    wss.clients.forEach(function each(client){
      if (client.readyState === WebSocket.OPEN){
        client.send('reload')
      }
    })
  }

  if(options.watch || options.watch==null){
    watchPath(pathTo, reloader, options).then(monitor=>{
      reloader.monitor = monitor
    })
  }

  return reloader
}

/** returns watch.createMonitor. See npm watch */
function watchPath(pathTo, reloader, options){
  options = options || {}
  options.filter = options.filter || filterMaker('js','css','html')

  return new Promise(function(res,rej){
    watch.createMonitor(pathTo, options, function (monitor) {
      monitor.on("created", reloader)
      monitor.on("changed", reloader)
      monitor.on("removed", reloader)
      //process.once('SIGINT', function(){monitor.stop()})
      process.once('exit', function(){monitor.stop()})
      res( monitor )
    })
  })
}

/** returns promise Object{httpServer,port} */
function startServer(app, port, options){
  return new Promise(function(respond,reject){
    var httpServer = http.createServer(app)

    httpServer.once('error',function(e){
      reject(e)
    })

    httpServer.once('listening',function(e){
      process.once('exit', function(){
        httpServer.close()
      })

      respond({httpServer:httpServer, port:port})
    })


    httpServer.listen(port)
  })
  .catch(function(e){
    if(e.code=='EADDRINUSE'){
      return promptPortInUse(app, port, options)
    }

    throw e
  })
  .then(function(config){
    promisePrompt.stop()
    return config
  })
}

/** returns promise */
function promptPortInUse(app, port, options){
  return promisePrompt([{
    description:'Port '+port+' in use. Type new port number. 0 to stop:',
    name:'port',
    default:port+1,
    pattern: /^[0-9]+$/,
    message: 'Port must be a number',
  }],options)
  .then(function(res){
    var port = Number(res.port)
    if(port){
      return startServer(app, port, options)
    }
  })
}

function isHtmlRequest(req, html5Mode){
  var urlReview = req.url.replace(/\?.*/g,'')
  var index = urlReview ==='/' || urlReview.search(/[^?]*(\.html)/)>=0
  var noExt = html5Mode && urlReview.search(/^[^?]+(\.[^?]+)(\?|$)/)<0
  //var noExt = urlReview.search(/^[^?]+(\.[^?]+)(\?|$)/)<0
  return index || noExt ? true : false
}

function isReloadJsRequest(req){
  return req.url.toLowerCase().search(/reload\/reload\.js/)>=0
}

function isRequestForReload(req){
  return isHtmlRequest(req) || isReloadJsRequest(req)
}